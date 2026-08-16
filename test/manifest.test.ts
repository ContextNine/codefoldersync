import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest, findToken } from "../src/manifest.js";

test("manifest and token search exclude hidden local-state directories", () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-manifest-"));
  try {
    writeFileSync(join(root, "visible.txt"), "visible-token\n");
    mkdirSync(join(root, ".private-state"));
    writeFileSync(
      join(root, ".private-state", "account.json"),
      "secret-token\n",
    );

    assert.deepEqual(
      buildManifest(root).map((entry) => entry.path),
      ["visible.txt"],
    );
    assert.deepEqual(findToken(root, "secret-token"), []);
    assert.deepEqual(findToken(root, "visible-token"), ["visible.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
