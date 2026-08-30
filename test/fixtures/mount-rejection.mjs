import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cli = process.argv[2];
assert.ok(cli, "product CLI path is required");
const root = "/work/Code";
const state = "/work/state";
const hub = "/work/hub";
const config = join(root, ".codefoldersync", "config.json");
const mounted = join(root, "mounted");
mkdirSync(mounted, { recursive: true, mode: 0o700 });
const mount = spawnSync(
  "mount",
  [
    "-t",
    "tmpfs",
    "-o",
    "size=1m,nosuid,nodev,noexec",
    "codefoldersync-test",
    mounted,
  ],
  { encoding: "utf8" },
);
assert.equal(mount.status, 0, mount.stderr);

const run = (args) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
try {
  writeFileSync(join(root, "source.ts"), "export const source = true;\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    join(mounted, "private.ts"),
    "export const privateValue = 1;\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  const setup = run([
    "setup",
    "--mode",
    "authority",
    "--root",
    root,
    "--state",
    state,
    "--config",
    config,
    "--hub",
    hub,
    "--backup-witness",
    "nested-mount-integration",
  ]);
  assert.equal(setup.status, 0, setup.stderr);
  const seal = run(["adoption", "seal", "--config", config]);
  assert.equal(seal.status, 2, seal.stderr);
  assert.match(seal.stderr, /Nested mount is unsupported: mounted/u);
  const status = run(["status", "--config", config]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).hubSequence, 0);
  process.stdout.write(
    `${JSON.stringify({ rejected: true, hubSequence: 0, mountType: "tmpfs" })}\n`,
  );
} finally {
  const unmount = spawnSync("umount", [mounted], { encoding: "utf8" });
  assert.equal(unmount.status, 0, unmount.stderr);
}
