import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkStorageBudget,
  cleanupRunRoot,
  estimateCiphertextReceiptBytes,
  estimateSourceCaptureTransientBytes,
  inspectPhysicalTree,
  storageLimits,
} from "../src/v3/storage.js";

test("bounded acceptance storage is physical, capped, and cleanable", () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-storage-"));
  try {
    const inventoryRoot = join(base, "inventory-root");
    mkdirSync(join(inventoryRoot, "nested"), { recursive: true });
    writeFileSync(join(inventoryRoot, "nested", "source.txt"), "payload\n");
    linkSync(
      join(inventoryRoot, "nested", "source.txt"),
      join(inventoryRoot, "hard-link.txt"),
    );
    symlinkSync("missing", join(inventoryRoot, "dangling-link"));
    const sparse = openSync(join(inventoryRoot, "sparse.bin"), "wx", 0o600);
    writeSync(sparse, Buffer.from("tail"), 0, 4, 16 * 1024 * 1024);
    closeSync(sparse);

    const inventory = inspectPhysicalTree(inventoryRoot);
    assert.equal(inventory.schemaVersion, 1);
    assert.equal(inventory.directories, 2);
    assert.equal(inventory.files, 3);
    assert.equal(inventory.symlinks, 1);
    assert.ok(inventory.logicalBytes > inventory.allocatedBytes);
    assert.ok(estimateSourceCaptureTransientBytes(inventory) > 0);
    assert.ok(estimateCiphertextReceiptBytes(inventory) > 0);

    const accepted = checkStorageBudget({
      profile: "mac-transient",
      inventory,
      baselineAllocatedBytes: inventory.allocatedBytes,
      projectedAdditionalBytes: 1024,
    });
    assert.equal(accepted.passed, true);
    assert.equal(accepted.hardLimitBytes, storageLimits.macTransientBytes);
    assert.throws(
      () =>
        checkStorageBudget({
          profile: "mac-transient",
          inventory,
          baselineAllocatedBytes: inventory.allocatedBytes,
          projectedAdditionalBytes: storageLimits.macTransientBytes + 1,
        }),
      /hard storage limit/u,
    );

    const cleanupRoot = join(base, "run-storage-test");
    mkdirSync(join(cleanupRoot, "protected"), { recursive: true });
    writeFileSync(join(cleanupRoot, "SENTINEL"), "storage-test\n");
    writeFileSync(join(cleanupRoot, "protected", "value"), "value\n");
    symlinkSync("missing", join(cleanupRoot, "protected", "dangling"));
    chmodSync(join(cleanupRoot, "protected", "value"), 0o400);
    chmodSync(join(cleanupRoot, "protected"), 0o500);
    const cleaned = cleanupRunRoot({
      schemaVersion: 1,
      runId: "storage-test",
      runRoot: cleanupRoot,
    });
    assert.equal(cleaned.removed, true);
    assert.equal(existsSync(cleanupRoot), false);

    const refused = join(base, "run-refused-test");
    mkdirSync(refused);
    writeFileSync(join(refused, "SENTINEL"), "different-run\n");
    assert.throws(
      () =>
        cleanupRunRoot({
          schemaVersion: 1,
          runId: "refused-test",
          runRoot: refused,
        }),
      /sentinel/u,
    );
    assert.equal(existsSync(refused), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
