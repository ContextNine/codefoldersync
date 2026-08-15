import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareLive } from "../src/live.js";
import { validateRunRoot } from "../src/paths.js";
import type { HarnessConfig, PeerName } from "../src/types.js";

test("live preparation deploys the peer worker only inside sentinel roots", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-live-prepare-"));
  try {
    const peers = (["alpha", "beta", "gamma"] as const).map((name) => {
      const parent = join(temporary, name);
      mkdirSync(parent, { recursive: true });
      return {
        name,
        host: "local" as const,
        runBase: join(parent, "runs"),
        treesyncBinary: "/bin/true",
        nodeBinary: process.execPath,
      };
    });
    const config: HarnessConfig = {
      quietSamples: 2,
      quietIntervalMs: 1,
      convergenceTimeoutMs: 100,
      peers,
    };
    const capabilities = prepareLive(config, "prepare-test", 91);
    assert.deepEqual(Object.keys(capabilities).sort(), [
      "alpha",
      "beta",
      "gamma",
    ] satisfies PeerName[]);
    for (const peer of peers) {
      const paths = validateRunRoot(peer.runBase, "prepare-test");
      assert.equal(existsSync(join(paths.tools, "peer-worker.js")), true);
      assert.equal(
        existsSync(join(paths.control, "filesystem-capabilities.json")),
        true,
      );
    }
    const alpha = peers.find((peer) => peer.name === "alpha");
    assert.ok(alpha);
    assert.equal(
      existsSync(
        join(
          validateRunRoot(alpha.runBase, "prepare-test").workspace,
          "atlas",
          ".git",
        ),
      ),
      true,
    );
    const alphaPaths = validateRunRoot(alpha.runBase, "prepare-test");
    writeFileSync(
      join(alphaPaths.control, "test-heartbeat.json"),
      `${JSON.stringify({ expiresAt: Date.now() + 100 })}\n`,
    );
    const supervised = spawnSync(
      process.execPath,
      [
        join(alphaPaths.tools, "peer-worker.js"),
        "supervise-expiry-probe",
        "--run-base",
        alpha.runBase,
        "--run",
        "prepare-test",
        "--peer",
        "alpha",
        "--repository",
        "atlas",
        "--operation",
        "prepare-expiry-probe",
        "--path",
        "guard/must-not-exist.txt",
        "--heartbeat",
        "test-heartbeat.json",
        "--child-delay-ms",
        "2000",
      ],
      { encoding: "utf8" },
    );
    assert.equal(supervised.status, 0, supervised.stderr);
    assert.equal(
      existsSync(
        join(alphaPaths.workspace, "atlas", "guard", "must-not-exist.txt"),
      ),
      false,
    );
    assert.throws(() => prepareLive(config, "prepare-test", 91));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
