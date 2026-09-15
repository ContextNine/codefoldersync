import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateBoundedCorpus } from "../src/v3/corpus.js";
import { cleanupRunRoot, storageLimits } from "../src/v3/storage.js";

test("generated acceptance corpus is deterministic in shape and capped", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codefoldersync-corpus-"));
  const runId = "corpus-test";
  const outputBase = join(parent, "run-corpus-test");
  try {
    mkdirSync(outputBase, { mode: 0o700 });
    writeFileSync(join(outputBase, "SENTINEL"), `${runId}\n`, {
      mode: 0o600,
    });
    const spec = {
      schemaVersion: 1 as const,
      runId,
      seed: "accepted-seed",
      outputBase,
      corpusRoot: join(outputBase, "Code"),
      shape: {
        directories: 12,
        files: 40,
        symlinks: 4,
        executableFiles: 5,
        gitRepositories: 2,
        maxDepth: 4,
        payloadBytes: 512 * 1024,
      },
    };
    const result = await generateBoundedCorpus(spec);
    assert.equal(result.passed, true);
    assert.equal(result.inventory.files >= spec.shape.files, true);
    assert.equal(result.inventory.symlinks, spec.shape.symlinks);
    assert.ok(
      result.inventory.allocatedBytes < storageLimits.boundedCorpusBytes,
    );
    assert.match(result.shapeSha256, /^[a-f0-9]{64}$/u);
    assert.ok(result.witness.files > spec.shape.files);

    const cleaned = cleanupRunRoot({
      schemaVersion: 1,
      runId,
      runRoot: outputBase,
    });
    assert.equal(cleaned.removed, true);

    await assert.rejects(
      generateBoundedCorpus({
        ...spec,
        outputBase: join(parent, "missing-base"),
        corpusRoot: join(parent, "missing-base", "Code"),
        shape: {
          ...spec.shape,
          payloadBytes: storageLimits.boundedCorpusBytes + 1,
        },
      }),
      /fixed limits/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
