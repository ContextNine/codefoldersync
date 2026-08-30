import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
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
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { canonicalJson, hashText } from "../src/v2/hash.js";
import {
  createTreeWitness,
  makeTreeOwnerWritable,
} from "../src/v3/acceptance.js";
import { writeSemanticManifest } from "../src/v3/backup.js";
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
    const manifest = join(root, "manifest.ndjson");
    const members = join(root, "members");
    const compressedManifest = join(root, "manifest.ndjson.zst");
    const encryptedManifest = join(
      bundle,
      `${machineId}-manifest.ndjson.zst.age`,
    );
    mkdirSync(join(code, "packages", "app"), { recursive: true });
    mkdirSync(bundle);
    mkdirSync(destinationBase);
    writeFileSync(join(destinationBase, "SENTINEL"), `${runId}\n`);
    writeFileSync(join(code, "packages", "app", "index.ts"), "export {};\n");
    writeFileSync(join(code, "tool.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(join(code, "a-original.txt"), "hard-linked\n");
    linkSync(join(code, "a-original.txt"), join(code, "z-link.txt"));
    symlinkSync("missing-target", join(code, "broken-link"));

    run("age-keygen", ["--output", identity]);
    const recipient = run("age-keygen", ["--y", identity]).stdout.trim();
    assert.match(recipient, /^age1/u);
    run("tar", [
      "--create",
      "--zstd",
      "--format=pax",
      "--pax-option=LIBARCHIVE.creationtime:=123",
      "--pax-option=LIBARCHIVE.xattr.com.docker.grpcfuse.ownership:=501:20",
      "--pax-option=SCHILY.acl.ace:=group:everyone:d::deny:12",
      "--pax-option=SCHILY.fflags:=uchg",
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
    const semantic = await writeSemanticManifest({
      root: code,
      output: manifest,
      membersOutput: members,
      snapshotId,
      machineId,
      sourcePlatform: "macos",
      archiveMetadataSha256: "0".repeat(64),
    });
    run("zstd", ["--compress", "--quiet", "-o", compressedManifest, manifest]);
    run("age", [
      "--encrypt",
      "--recipient",
      recipient,
      "--output",
      encryptedManifest,
      compressedManifest,
    ]);
    const ciphertextBytes = statSync(ciphertext).size;
    const ciphertextSha256 = createHash("sha256")
      .update(readFileSync(ciphertext))
      .digest("hex");
    const manifestCiphertextBytes = statSync(encryptedManifest).size;
    const manifestCiphertextSha256 = createHash("sha256")
      .update(readFileSync(encryptedManifest))
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
          {
            name: `${machineId}-manifest.ndjson.zst.age`,
            size: manifestCiphertextBytes,
            sha256: manifestCiphertextSha256,
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
    assert.equal(result.archiveCiphertextSha256, ciphertextSha256);
    assert.equal(result.archiveCiphertextBytes, ciphertextBytes);
    assert.equal(result.manifestCiphertextSha256, manifestCiphertextSha256);
    assert.equal(result.manifestCiphertextBytes, manifestCiphertextBytes);
    assert.equal(result.portableSemanticSha256, semantic.portableSha256);
    assert.equal(result.platformMetadataVerified, false);
    assert.ok(result.ignoredArchiveMetadataRecords >= 4);
    assert.equal(result.protected, true);
    assert.equal(result.witness.files, 4);
    assert.equal(result.witness.symlinks, 1);
    assert.equal(
      result.witness.digest,
      legacyTreeDigest(join(destination, "Code")),
    );
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
    assert.equal(
      lstatSync(join(destination, "Code", "a-original.txt")).ino,
      lstatSync(join(destination, "Code", "z-link.txt")).ino,
    );
    const corruptBundle = join(root, "corrupt-bundle");
    cpSync(bundle, corruptBundle, { recursive: true });
    const corruptManifest = join(
      corruptBundle,
      `${machineId}-manifest.ndjson.zst.age`,
    );
    const corrupted = readFileSync(corruptManifest);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    writeFileSync(corruptManifest, corrupted);
    await assert.rejects(
      restoreEncryptedMaster({
        ...spec,
        bundleDirectory: corruptBundle,
        destination: join(destinationBase, `${machineId}-corrupt`),
      }),
      /Ciphertext artifact digest/u,
    );
    const sensitiveBundle = "/sensitive-backup-root-never-print/bundle";
    await assert.rejects(
      restoreEncryptedMaster({
        ...spec,
        bundleDirectory: sensitiveBundle,
        destination: join(destinationBase, `${machineId}-missing`),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(
          error.message,
          /sensitive-backup-root-never-print/u,
        );
        return true;
      },
    );
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

function legacyTreeDigest(root: string): string {
  const absoluteRoot = resolve(root);
  const records: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const local = relative(absoluteRoot, path).split(sep).join("/");
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        records.push(canonicalJson([local, "directory", mode]));
        visit(path);
      } else if (stat.isFile()) {
        records.push(
          canonicalJson([
            local,
            "regular",
            mode,
            stat.size,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
          ]),
        );
      } else if (stat.isSymbolicLink()) {
        records.push(
          canonicalJson([local, "symlink", mode, readlinkSync(path)]),
        );
      }
    }
  };
  visit(absoluteRoot);
  return hashText(records.join("\n"));
}

function run(
  command: string,
  args: readonly string[],
): { readonly stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return { stdout: result.stdout };
}
