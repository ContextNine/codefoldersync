import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git } from "../src/git.js";
import { prepareLive } from "../src/live.js";
import { validateRunRoot } from "../src/paths.js";
import type { HarnessConfig, PeerName } from "../src/types.js";

test("live preparation deploys the peer worker only inside sentinel roots", () => {
  const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-live-prepare-"));
  try {
    const peers = (["alpha", "beta", "gamma"] as const).map((name) => {
      const parent = join(temporary, name);
      mkdirSync(parent, { recursive: true });
      return {
        name,
        host: "local" as const,
        runBase: join(parent, "runs"),
        codefoldersyncBinary: "/bin/true",
        codefoldersyncHome: parent,
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
    const daemonBinary = join(temporary, "codefoldersync-test-daemon");
    writeFileSync(
      daemonBinary,
      "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
      { mode: 0o755 },
    );
    const serviceArgs = [
      join(alphaPaths.tools, "peer-worker.js"),
      "codefoldersync-service",
      "--run-base",
      alpha.runBase,
      "--run",
      "prepare-test",
      "--action",
      "start",
      "--binary",
      daemonBinary,
      "--home",
      join(alphaPaths.control, "codefoldersync-home"),
    ];
    const startedService = spawnSync(process.execPath, serviceArgs, {
      encoding: "utf8",
    });
    assert.equal(startedService.status, 0, startedService.stderr);
    assert.equal(JSON.parse(startedService.stdout).running, true);
    const stoppedService = spawnSync(
      process.execPath,
      serviceArgs.map((value, index) =>
        index > 0 && serviceArgs[index - 1] === "--action" ? "stop" : value,
      ),
      { encoding: "utf8" },
    );
    assert.equal(stoppedService.status, 0, stoppedService.stderr);
    assert.equal(JSON.parse(stoppedService.stdout).running, false);
    const churn = spawnSync(
      process.execPath,
      [
        join(alphaPaths.tools, "peer-worker.js"),
        "churn",
        "--run-base",
        alpha.runBase,
        "--run",
        "prepare-test",
        "--peer",
        "alpha",
        "--repository",
        "atlas",
        "--count",
        "14",
        "--guarded",
      ],
      { encoding: "utf8" },
    );
    assert.equal(churn.status, 0, churn.stderr);
    const churnResult = JSON.parse(churn.stdout) as Array<{
      readonly kind?: string;
      readonly type: string;
    }>;
    assert.ok(churnResult.some((operation) => operation.kind === "append"));
    assert.ok(churnResult.some((operation) => operation.kind === "replace"));
    assert.ok(churnResult.some((operation) => operation.type === "delete"));
    assert.equal(
      existsSync(
        join(alphaPaths.workspace, "atlas", "churn/alpha/renamed-1.txt"),
      ),
      true,
    );
    assert.notEqual(
      statSync(
        join(alphaPaths.workspace, "atlas", "churn/alpha/operation-2.txt"),
      ).mode & 0o111,
      0,
    );
    assert.match(
      readFileSync(
        join(alphaPaths.workspace, "atlas", "churn/alpha/operation-5.txt"),
        "utf8",
      ),
      /append baseline[\s\S]+append payload/,
    );
    assert.doesNotMatch(
      readFileSync(
        join(alphaPaths.workspace, "atlas", "churn/alpha/operation-6.txt"),
        "utf8",
      ),
      /replace baseline/,
    );
    assert.equal(
      existsSync(join(alphaPaths.workspace, "atlas", "src/nested/file-7.txt")),
      false,
    );
    assert.equal(
      git(join(alphaPaths.workspace, "atlas"), [
        "rev-parse",
        "--verify",
        "refs/codefoldersync/alpha/churn-alpha-commit",
      ]).status,
      0,
    );
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
