import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createArchiveMetadataDigest,
  type EncryptedBackupCaptureResult,
  validateSemanticManifest,
  writeSemanticManifest,
} from "../src/v3/backup.js";

test("backup capture seals an encrypted archive and portable semantic oracle", async () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-backup-"));
  try {
    chmodSync(root, 0o700);
    const runId = "backup-test";
    const source = join(root, "source", "Code");
    const staging = join(root, "staging");
    const bundle = join(staging, "bundle");
    mkdirSync(join(source, "repo", "empty"), { recursive: true });
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, "SENTINEL"), `${runId}\n`, { mode: 0o600 });
    writeFileSync(
      join(source, "repo", "index.ts"),
      "export const answer = 42;\n",
    );
    writeFileSync(join(source, "tool.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    symlinkSync("repo/index.ts", join(source, "relative-link"));
    symlinkSync("missing", join(source, "broken-link"));
    symlinkSync("/tmp", join(source, "absolute-link"));
    const sparse = openSync(join(source, "sparse.bin"), "wx", 0o600);
    writeSync(sparse, Buffer.from("tail"), 0, 4, 1024 * 1024);
    closeSync(sparse);
    run("git", ["init", "-q"], source);
    run("git", ["config", "user.name", "Fixture"], source);
    run("git", ["config", "user.email", "fixture@example.invalid"], source);
    run("git", ["add", "."], source);
    run("git", ["commit", "-qm", "fixture"], source);
    if (process.platform === "linux")
      setLinuxXattr(join(source, "repo", "index.ts"), "alpha-proof");

    const mattIdentity = join(root, "mattbook.agekey");
    const wootIdentity = join(root, "wootbook.agekey");
    run("age-keygen", ["--output", mattIdentity], root, true);
    run("age-keygen", ["--output", wootIdentity], root, true);
    const recipients = [
      run("age-keygen", ["--y", mattIdentity], root).stdout.trim(),
      run("age-keygen", ["--y", wootIdentity], root).stdout.trim(),
    ];
    const probeManifest = join(root, "probe.ndjson");
    const probeMembers = join(root, "probe.members");
    await writeSemanticManifest({
      root: source,
      output: probeManifest,
      membersOutput: probeMembers,
      snapshotId: "snapshot-test",
      machineId: "wootbook",
      sourcePlatform: "linux",
      archiveMetadataSha256: null,
    });
    const firstMetadata = await createArchiveMetadataDigest(
      source,
      "linux",
      probeMembers,
    );
    assert.match(firstMetadata, /^[a-f0-9]{64}$/u);
    if (process.platform === "linux") {
      setLinuxXattr(join(source, "repo", "index.ts"), "omega-proof");
      assert.notEqual(
        await createArchiveMetadataDigest(source, "linux", probeMembers),
        firstMetadata,
      );
    }
    const captureSpec = join(root, "capture.json");
    const captureSpecValue = {
      schemaVersion: 1,
      runId,
      snapshotId: "snapshot-test",
      machineId: "wootbook",
      sourcePlatform: "linux",
      sourceCodeRoot: source,
      stagingBase: staging,
      bundleDirectory: bundle,
      recipients,
    };
    writeFileSync(captureSpec, `${JSON.stringify(captureSpecValue)}\n`, {
      mode: 0o600,
    });
    const unapproved = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "product-cli.ts"),
        "acceptance",
        "capture-backup",
        "--spec",
        captureSpec,
      ],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    );
    assert.equal(unapproved.status, 2);
    assert.match(unapproved.stderr, /requires explicit --approve/u);
    assert.equal(existsSync(bundle), false);
    const missingSpec = join(root, "missing-capture.json");
    const sensitivePath = "/sensitive-code-root-never-print/Code";
    writeFileSync(
      missingSpec,
      `${JSON.stringify({
        ...captureSpecValue,
        sourceCodeRoot: sensitivePath,
        bundleDirectory: join(staging, "missing-bundle"),
      })}\n`,
      { mode: 0o600 },
    );
    const rejected = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "product-cli.ts"),
        "acceptance",
        "capture-backup",
        "--spec",
        missingSpec,
        "--approve",
      ],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    );
    assert.equal(rejected.status, 2);
    assert.doesNotMatch(rejected.stderr, /sensitive-code-root-never-print/u);
    const captured = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "product-cli.ts"),
        "acceptance",
        "capture-backup",
        "--spec",
        captureSpec,
        "--approve",
      ],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    );
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(captured.stderr, "");
    const result = JSON.parse(captured.stdout) as EncryptedBackupCaptureResult;
    assert.equal(result.passed, true);
    assert.equal(result.warnings, 0);
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(readdirSync(bundle).sort(), [
      "witness.json",
      "wootbook-Code.tar.zst.age",
      "wootbook-manifest.ndjson.zst.age",
    ]);
    for (const artifact of result.artifacts)
      assert.equal(statSync(join(bundle, artifact.name)).mode & 0o777, 0o600);

    const manifestCompressed = join(root, "manifest.ndjson.zst");
    const manifest = join(root, "manifest.ndjson");
    run(
      "age",
      [
        "--decrypt",
        "--identity",
        mattIdentity,
        "--output",
        manifestCompressed,
        join(bundle, "wootbook-manifest.ndjson.zst.age"),
      ],
      root,
    );
    run(
      "zstd",
      ["--decompress", "--quiet", "-o", manifest, manifestCompressed],
      root,
    );
    const expected = await validateSemanticManifest(manifest);
    assert.equal(expected.portableSha256, result.semantic.portableSha256);
    assert.equal(
      expected.archiveMetadataSha256,
      result.semantic.archiveMetadataSha256,
    );
    assert.equal(expected.unsupportedObjects, 0);
    assert.equal(expected.readFailures, 0);
    assert.equal(expected.gitBoundaries, 1);

    const archive = join(root, "archive.tar.zst");
    const restored = join(root, "restored");
    mkdirSync(restored, { mode: 0o700 });
    run(
      "age",
      [
        "--decrypt",
        "--identity",
        wootIdentity,
        "--output",
        archive,
        join(bundle, "wootbook-Code.tar.zst.age"),
      ],
      root,
    );
    run(
      "tar",
      [
        "--extract",
        "--zstd",
        `--file=${archive}`,
        `--directory=${restored}`,
        "--same-permissions",
        "--delay-directory-restore",
        "--acls",
        "--xattrs",
      ],
      root,
    );
    const actualManifest = join(root, "actual.ndjson");
    const actualMembers = join(root, "actual.members");
    const actualWithoutPlatform = await writeSemanticManifest({
      root: join(restored, "Code"),
      output: actualManifest,
      membersOutput: actualMembers,
      snapshotId: "snapshot-test",
      machineId: "wootbook",
      sourcePlatform: "linux",
      archiveMetadataSha256: null,
    });
    const actualMetadata = await createArchiveMetadataDigest(
      join(restored, "Code"),
      "linux",
      actualMembers,
    );
    assert.equal(actualWithoutPlatform.portableSha256, expected.portableSha256);
    assert.equal(actualMetadata, expected.archiveMetadataSha256);
    assert.equal(
      readFileSync(join(restored, "Code", "tool.sh"), "utf8"),
      "#!/bin/sh\nexit 0\n",
    );
  } finally {
    makeWritable(root);
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "semantic capture rejects paths that collide after Unicode normalization",
  { skip: process.platform !== "linux" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "codefoldersync-unicode-alias-"));
    try {
      const code = join(root, "Code");
      mkdirSync(code);
      writeFileSync(join(code, "café.txt"), "composed\n");
      writeFileSync(join(code, "cafe\u0301.txt"), "decomposed\n");
      await assert.rejects(
        writeSemanticManifest({
          root: code,
          output: join(root, "manifest.ndjson"),
          membersOutput: join(root, "members"),
          snapshotId: "unicode-alias-test",
          machineId: "wootbook",
          sourcePlatform: "linux",
          archiveMetadataSha256: null,
        }),
        /portable path alias/u,
      );
    } finally {
      makeWritable(root);
      rmSync(root, { force: true, recursive: true });
    }
  },
);

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  allowStderr = false,
): { readonly stdout: string } {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  if (!allowStderr)
    assert.equal(result.stderr, "", `${command} emitted a warning`);
  return { stdout: result.stdout };
}

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

function setLinuxXattr(path: string, value: string): void {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import os,sys; os.setxattr(sys.argv[1], 'user.codefoldersync', sys.argv[2].encode())",
      path,
      value,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}
