import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("release installer is idempotent and verifies exact version", () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-release-"));
  const installRoot = join(root, "lib");
  const bin = join(root, "bin");
  const command = [
    "scripts/install.py",
    "--release-sha256",
    "a".repeat(64),
    "--install-root",
    installRoot,
    "--bin-dir",
    bin,
    "--json",
  ];
  const run = (extra: readonly string[] = []) =>
    spawnSync("python3", [...command, ...extra], { encoding: "utf8" });
  const first = run();
  const second = run();
  const verified = run(["--verify"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).changed, true);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).changed, false);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).ready, true);

  const helpRoot = join(root, "help-must-not-install");
  const help = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "product-cli.js"),
      "install",
      "--help",
      "--install-root",
      helpRoot,
      "--bin-dir",
      join(root, "help-bin"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: codefoldersync install/u);
  assert.equal(existsSync(helpRoot), false);
});
