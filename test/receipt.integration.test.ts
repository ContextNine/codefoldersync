import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  finalizeBackupReceipt,
  receiveBackupArtifact,
  receiveBackupWitness,
  type BackupReceiptSpec,
} from "../src/v3/receipt.js";
import { cleanupRunRoot, inspectPhysicalTree } from "../src/v3/storage.js";

test("Wootbook receives and finalizes one bounded ciphertext bundle", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codefoldersync-receipt-"));
  const runId = "receipt-test";
  const root = join(parent, "run-receipt-test");
  try {
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "SENTINEL"), `${runId}\n`, { mode: 0o600 });
    const baseline = inspectPhysicalTree(root).allocatedBytes;
    const spec: BackupReceiptSpec = {
      schemaVersion: 1,
      runId,
      snapshotId: "snapshot-test",
      machineId: "mattbook",
      receiptBase: root,
      sessionDirectory: join(root, "incoming-mattbook"),
      bundleDirectory: join(root, "mattbook-bundle"),
      baselineAllocatedBytes: baseline,
      projectedBytes: 1024 * 1024,
    };
    const archive = Buffer.from("encrypted archive bytes");
    const manifest = Buffer.from("encrypted manifest bytes");
    const archiveReceipt = await receiveBackupArtifact(
      spec,
      "archive",
      Readable.from([archive]),
    );
    const manifestReceipt = await receiveBackupArtifact(
      spec,
      "manifest",
      Readable.from([manifest]),
    );
    assert.equal(
      archiveReceipt.sha256,
      createHash("sha256").update(archive).digest("hex"),
    );
    assert.equal(
      manifestReceipt.sha256,
      createHash("sha256").update(manifest).digest("hex"),
    );
    const witness = {
      schema_version: 1,
      snapshot_id: spec.snapshotId,
      machine_id: spec.machineId,
      artifacts: [archiveReceipt, manifestReceipt].map(
        ({ name, size, sha256 }) => ({ name, size, sha256 }),
      ),
    };
    await receiveBackupWitness(
      spec,
      Readable.from([Buffer.from(JSON.stringify(witness))]),
    );
    const finalized = await finalizeBackupReceipt(spec);
    assert.equal(finalized.finalized, true);
    assert.deepEqual(readdirSync(spec.bundleDirectory).sort(), [
      "mattbook-Code.tar.zst.age",
      "mattbook-manifest.ndjson.zst.age",
      "witness.json",
    ]);
    assert.deepEqual(
      readFileSync(join(spec.bundleDirectory, archiveReceipt.name)),
      archive,
    );

    const cleanup = cleanupRunRoot({
      schemaVersion: 1,
      runId,
      runRoot: root,
    });
    assert.equal(cleanup.removed, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
