import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTreeWitness,
  makeTreeOwnerWritable,
} from "../src/v3/acceptance.js";
import { restoreEncryptedMaster } from "../src/v3/restore.js";

test("encrypted restore verifies ciphertext and creates an immutable master", async () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-restore-"));
  try {
    const runId = "restore-test";
    const snapshotId = "snapshot-test";
    const machineId = "machine-test";
    const source = join(root, "source");
    const code = join(source, "Code");
    const bundle = join(root, "bundle");
    const destinationBase = join(root, "masters");
    const destination = join(destinationBase, machineId);
    const identity = join(root, "identity.txt");
    const archive = join(root, "snapshot.tar.zst");
    const ciphertext = join(bundle, `${machineId}.tar.zst.age`);
    mkdirSync(join(code, "packages", "app"), { recursive: true });
    mkdirSync(bundle);
    mkdirSync(destinationBase);
    writeFileSync(join(destinationBase, "SENTINEL"), `${runId}\n`);
    writeFileSync(join(code, "packages", "app", "index.ts"), "export {};\n");
    writeFileSync(join(code, "tool.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    symlinkSync("missing-target", join(code, "broken-link"));

    run("age-keygen", ["--output", identity]);
    const recipient = run("age-keygen", ["--y", identity]).stdout.trim();
    assert.match(recipient, /^age1/u);
    run("tar", [
      "--create",
      "--zstd",
      "--format=pax",
      "--pax-option=LIBARCHIVE.creationtime:=123",
      `--file=${archive}`,
      "--directory",
      source,
      "Code",
    ]);
    run("age", [
      "--encrypt",
      "--recipient",
      recipient,
      "--output",
      ciphertext,
      archive,
    ]);
    const ciphertextBytes = statSync(ciphertext).size;
    const ciphertextSha256 = createHash("sha256")
      .update(readFileSync(ciphertext))
      .digest("hex");
    writeFileSync(
      join(bundle, "witness.json"),
      `${JSON.stringify({
        schema_version: 1,
        snapshot_id: snapshotId,
        machine_id: machineId,
        artifacts: [
          {
            name: `${machineId}.tar.zst.age`,
            size: ciphertextBytes,
            sha256: ciphertextSha256,
          },
        ],
      })}\n`,
    );

    const spec = {
      schemaVersion: 1 as const,
      runId,
      snapshotId,
      machineId,
      archivePlatform: "macos" as const,
      destinationBase,
      destination,
      bundleDirectory: bundle,
      identityPath: identity,
    };
    const result = await restoreEncryptedMaster(spec);
    assert.equal(result.ciphertextSha256, ciphertextSha256);
    assert.equal(result.ciphertextBytes, ciphertextBytes);
    assert.ok(result.ignoredArchiveMetadataRecords > 0);
    assert.equal(result.protected, true);
    assert.equal(result.witness.files, 2);
    assert.equal(result.witness.symlinks, 1);
    assert.equal(
      readFileSync(
        join(destination, "Code", "packages", "app", "index.ts"),
        "utf8",
      ),
      "export {};\n",
    );
    assert.equal(
      readlinkSync(join(destination, "Code", "broken-link")),
      "missing-target",
    );
    assert.equal(
      lstatSync(join(destination, "Code", "tool.sh")).mode & 0o222,
      0,
    );
    assert.equal(
      lstatSync(join(destination, "Code", "tool.sh")).mode & 0o111,
      0o111,
    );
    assert.equal(lstatSync(join(destination, "Code")).mode & 0o222, 0);
    const masterWitness = await createTreeWitness(join(destination, "Code"));
    const workspace = join(root, "workspace");
    cpSync(join(destination, "Code"), workspace, {
      recursive: true,
      preserveTimestamps: true,
    });
    makeTreeOwnerWritable(workspace);
    writeFileSync(join(workspace, "packages", "app", "index.ts"), "changed\n");
    assert.deepEqual(
      await createTreeWitness(join(destination, "Code")),
      masterWitness,
    );
    await assert.rejects(restoreEncryptedMaster(spec), /destination exists/u);
  } finally {
    makeDirectoriesWritable(root);
    rmSync(root, { force: true, recursive: true });
  }
});

function makeDirectoriesWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path))
    makeDirectoriesWritable(join(path, entry));
}

function run(
  command: string,
  args: readonly string[],
): { readonly stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return { stdout: result.stdout };
}
