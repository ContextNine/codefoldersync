import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRunId,
  createRunRoot,
  removeRunRoot,
  validateRunRoot,
} from "../src/paths.js";

test("run roots require a matching sentinel before cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-paths-"));
  try {
    const base = join(temporary, "runs");
    const paths = createRunRoot(base, "safe-run-1");
    assert.equal(validateRunRoot(base, "safe-run-1").root, paths.root);
    removeRunRoot(base, "safe-run-1");
    assert.equal(existsSync(paths.root), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("unsafe run IDs are rejected", () => {
  for (const input of ["..", "../escape", "/tmp/no", "UPPER", "ab"]) {
    assert.throws(() => assertRunId(input));
  }
});

test("cleanup refuses a root without the sentinel", () => {
  const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-paths-"));
  try {
    assert.throws(() => removeRunRoot(temporary, "missing-run"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
