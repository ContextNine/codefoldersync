import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureEncryptedBackup } from "../src/v3/backup.js";
import { verifyEncryptedRestoreSlot } from "../src/v3/restore.js";
import { inspectPhysicalTree } from "../src/v3/storage.js";

test("sequential restore verifies and clears its reusable slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-restore-slot-"));
  try {
    const runId = "restore-slot-test";
    const source = join(root, "source", "Code");
    const captureBase = join(root, "capture-base");
    const capturedBundle = join(captureBase, "bundle");
    mkdirSync(source, { recursive: true });
    mkdirSync(captureBase, { mode: 0o700 });
    writeFileSync(join(captureBase, "SENTINEL"), `${runId}\n`);
    writeFileSync(join(source, "value.txt"), "restore me\n");
    const firstIdentity = join(root, "first.agekey");
    const secondIdentity = join(root, "second.agekey");
    run("age-keygen", ["--output", firstIdentity]);
    run("age-keygen", ["--output", secondIdentity]);
    const recipients = [
      run("age-keygen", ["--y", firstIdentity]).stdout.trim(),
      run("age-keygen", ["--y", secondIdentity]).stdout.trim(),
    ];
    await captureEncryptedBackup({
      schemaVersion: 1,
      runId,
      snapshotId: "restore-slot-snapshot",
      machineId: "wootbook",
      sourcePlatform: "linux",
      sourceCodeRoot: source,
      stagingBase: captureBase,
      bundleDirectory: capturedBundle,
      recipients,
    });

    const slot = join(root, "run-restore-slot");
    mkdirSync(slot, { mode: 0o700 });
    writeFileSync(join(slot, "SENTINEL"), `${runId}\n`);
    const baselineAllocatedBytes = inspectPhysicalTree(slot).allocatedBytes;
    const downloadedBundle = join(slot, "downloaded-bundle");
    cpSync(capturedBundle, downloadedBundle, { recursive: true });
    const result = await verifyEncryptedRestoreSlot({
      schemaVersion: 1,
      runId,
      snapshotId: "restore-slot-snapshot",
      machineId: "wootbook",
      archivePlatform: "linux",
      destinationBase: slot,
      destination: join(slot, "master"),
      bundleDirectory: downloadedBundle,
      identityPath: firstIdentity,
      baselineAllocatedBytes,
      projectedAdditionalBytes: 64 * 1024 * 1024,
    });
    assert.equal(result.slotCleaned, true);
    assert.ok(result.removedAllocatedBytes > 0);
    assert.equal(existsSync(slot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(
  command: string,
  arguments_: string[],
): { readonly stdout: string } {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout };
}
