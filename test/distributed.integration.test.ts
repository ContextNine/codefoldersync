import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createTreeWitness,
  runPseudoFleetAcceptanceV3,
  type PseudoFleetAcceptanceSpec,
} from "../src/v3/acceptance.js";
import {
  aiWorkloadPrompt,
  createAiWorkloadFixture,
  replayAiMutationCassette,
  runAiWriter,
} from "../src/v3/ai-workload.js";
import type { DistributedFleetSpec } from "../src/v3/distributed.js";
import {
  applyDistributedTargetV3,
  cutoverDistributedAcceptanceV3,
  prepareDistributedSetupV3,
  type DistributedExecutor,
} from "../src/v3/distributed.js";
import { ProcessDistributedExecutor } from "../src/v3/distributed-process.js";
import {
  runVisibilityObserver,
  type VisibilityEvent,
} from "../src/v3/visibility.js";
import { runIsolatedAgent } from "../src/v3/isolated.js";

test("distributed setup previews, prepares, resumes, and applies one approved target at a time", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-distributed-"));
  const runId = "distributed-integration-001";
  const releaseSha256 = "b".repeat(64);
  try {
    writeFileSync(join(base, "SENTINEL"), `${runId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const installRoot = join(base, "install");
    const binDir = join(base, "bin");
    const install = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "dist", "product-cli.js"),
        "install",
        "--built",
        join(process.cwd(), "dist"),
        "--install-root",
        installRoot,
        "--bin-dir",
        binDir,
        "--release-sha256",
        releaseSha256,
      ],
      { encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr);
    const binary = join(binDir, "codefoldersync");
    const authorityRoot = join(base, "authority", "Code");
    const betaRoot = join(base, "beta", "Code");
    const gammaRoot = join(base, "gamma", "Code");
    createTree(authorityRoot, "source");
    createTree(betaRoot, "beta");
    createTree(gammaRoot, "gamma");
    const machine = (
      machineId: string,
      root: string,
    ): DistributedFleetSpec["authority"] => ({
      machineId,
      peerName: machineId,
      endpoint: { kind: "local" },
      command: [binary],
      root,
      stateDir: join(base, machineId, "state"),
      configPath: join(root, ".codefoldersync", "config.json"),
    });
    const spec: DistributedFleetSpec = {
      schemaVersion: 1,
      runId,
      expectedVersion: "0.3.0",
      expectedReleaseSha256: releaseSha256,
      folderName: "distributed-integration",
      backupWitness: "verified-integration-backup",
      controllerStateDir: join(base, "controller"),
      hub: { kind: "local", path: join(base, "hub") },
      authority: machine("authority", authorityRoot),
      targets: [
        {
          ...machine("beta", betaRoot),
          role: "peer",
          requestPath: join(base, "beta", "request.json"),
        },
        {
          ...machine("gamma", gammaRoot),
          role: "hub",
          requestPath: join(base, "gamma", "request.json"),
        },
      ],
    };
    const specPath = join(base, "distributed.json");
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });

    const run = (args: readonly string[]) =>
      spawnSync(
        binary,
        ["setup", "--mode", "distributed", "--spec", specPath, ...args],
        {
          encoding: "utf8",
        },
      );
    const preview = run([]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).mutation, false);
    assert.equal(
      existsSync(join(base, "controller", "distributed-setup.json")),
      false,
    );

    const prepared = run(["--approve-prepare"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const preparation = JSON.parse(prepared.stdout) as {
      readonly prepared: boolean;
      readonly cutoverReady: boolean;
      readonly targets: readonly {
        readonly machineId: string;
        readonly adoptionId: string;
      }[];
    };
    assert.equal(preparation.prepared, true);
    assert.equal(preparation.cutoverReady, false);
    assert.equal(preparation.targets.length, 2);

    const resumed = run(["--approve-prepare"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), JSON.parse(prepared.stdout));

    for (const target of preparation.targets) {
      const applied = run([
        "--approve-target",
        target.machineId,
        "--adoption-id",
        target.adoptionId,
      ]);
      assert.equal(applied.status, 0, applied.stderr);
    }
    const final = run([]);
    assert.equal(final.status, 0, final.stderr);
    assert.equal(JSON.parse(final.stdout).cutoverReady, true);
    const cutover = await cutoverDistributedAcceptanceV3(
      spec,
      new ProcessDistributedExecutor(),
    );
    assert.equal(cutover.lifecycle, "normal");
    assert.deepEqual(
      await cutoverDistributedAcceptanceV3(
        spec,
        new ProcessDistributedExecutor(),
      ),
      cutover,
    );
    assert.equal(
      readFileSync(join(betaRoot, "src", "value.ts"), "utf8"),
      "export const value = 'source';\n",
    );
    assert.equal(
      readFileSync(join(gammaRoot, "src", "value.ts"), "utf8"),
      "export const value = 'source';\n",
    );
    assert.equal(
      readFileSync(join(authorityRoot, "src", "value.ts"), "utf8"),
      "export const value = 'source';\n",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isolated preparation copies a witnessed master into a fresh sentinel root", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-isolated-"));
  const runId = "isolated-integration-001";
  const repetitionId = `${runId}-realistic-01`;
  try {
    const runRoot = join(base, "run");
    mkdirSync(runRoot, { mode: 0o700 });
    writeFileSync(join(runRoot, "SENTINEL"), `${runId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const master = join(base, "master", "Code");
    createTree(master, "master");
    const witness = await createTreeWitness(master);
    const repetitionRoot = join(runRoot, repetitionId);
    const workspace = join(repetitionRoot, "Code");
    const request = {
      action: "prepare",
      machineId: "mattbook",
      baseRunId: runId,
      repetitionId,
      baseRunRoot: runRoot,
      repetitionRoot,
      workspace,
      masterRoot: master,
      masterWitness: witness,
      aiWorkspace: join(workspace, "codefoldersync-ai-workload"),
    } as const;
    const first = await runIsolatedAgent(request);
    const resumed = await runIsolatedAgent(request);
    assert.deepEqual(resumed, first);
    assert.equal(
      existsSync(
        join(
          workspace,
          "codefoldersync-ai-workload",
          "src",
          "domains",
          "domain-7",
          "handler-7.ts",
        ),
      ),
      true,
    );
    assert.deepEqual(await createTreeWitness(master), witness);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "disabled systemd installation starts, restarts, and removes its exact link",
  {
    skip:
      platform() !== "linux" ||
      spawnSync("systemctl", ["--user", "show-environment"], {
        stdio: "ignore",
      }).status !== 0,
  },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-systemd-"));
    const releaseSha256 = "f".repeat(64);
    const binary = installBinary(base, releaseSha256);
    const root = join(base, "Code");
    const state = join(base, "state");
    const hub = join(base, "hub");
    const config = join(root, ".codefoldersync", "config.json");
    const definitions = join(base, "service-definitions");
    createTree(root, "systemd");
    const run = (args: readonly string[]) =>
      spawnSync(binary, args, { encoding: "utf8" });
    let installed = false;
    try {
      assert.equal(
        run([
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
          "systemd-integration",
        ]).status,
        0,
      );
      assert.equal(run(["adoption", "seal", "--config", config]).status, 0);
      assert.equal(
        run(["adoption", "cutover", "--approve", "--config", config]).status,
        0,
      );
      const serviceArgs = [
        "--config",
        config,
        "--definition-dir",
        definitions,
        "--executable",
        binary,
      ] as const;
      const install = run(["service", "install", ...serviceArgs]);
      assert.equal(install.status, 0, install.stderr);
      const installedStatus = JSON.parse(install.stdout) as {
        readonly running: boolean;
        readonly definitionPath: string;
      };
      installed = true;
      assert.equal(installedStatus.running, false);
      const link = join(
        homedir(),
        ".config",
        "systemd",
        "user",
        basename(installedStatus.definitionPath),
      );
      assert.equal(existsSync(link), false);
      const started = run(["service", "start", ...serviceArgs]);
      assert.equal(started.status, 0, started.stderr);
      assert.equal(JSON.parse(started.stdout).running, true);
      assert.equal(existsSync(link), true);
      const stoppedForOfflineEdit = run(["service", "stop", ...serviceArgs]);
      assert.equal(
        stoppedForOfflineEdit.status,
        0,
        stoppedForOfflineEdit.stderr,
      );
      writeFileSync(
        join(root, "src", "offline-while-stopped.ts"),
        "export const offline = true;\n",
        { encoding: "utf8", mode: 0o600 },
      );
      const restartedAfterEdit = run(["service", "start", ...serviceArgs]);
      assert.equal(restartedAfterEdit.status, 0, restartedAfterEdit.stderr);
      const reconcileDeadline = Date.now() + 5_000;
      let hubSequence = 0;
      while (hubSequence < 3 && Date.now() < reconcileDeadline) {
        const status = run(["status", "--config", config]);
        assert.equal(status.status, 0, status.stderr);
        hubSequence = Number(JSON.parse(status.stdout).hubSequence);
        if (hubSequence < 3) await delay(25);
      }
      assert.ok(hubSequence >= 3);
      const restarted = run(["service", "restart", ...serviceArgs]);
      assert.equal(restarted.status, 0, restarted.stderr);
      assert.equal(JSON.parse(restarted.stdout).running, true);
      const stopped = run(["service", "stop", ...serviceArgs]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(JSON.parse(stopped.stdout).running, false);
      const uninstalled = run(["service", "uninstall", ...serviceArgs]);
      assert.equal(uninstalled.status, 0, uninstalled.stderr);
      installed = false;
      assert.equal(existsSync(link), false);
      assert.equal(existsSync(installedStatus.definitionPath), false);
    } finally {
      if (installed)
        run([
          "service",
          "uninstall",
          "--config",
          config,
          "--definition-dir",
          definitions,
          "--executable",
          binary,
        ]);
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  "an unreadable Linux subtree blocks sealing before hub publication",
  { skip: platform() !== "linux" || process.getuid?.() === 0 },
  () => {
    const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-unreadable-"));
    const releaseSha256 = "1".repeat(64);
    writeFileSync(join(base, "SENTINEL"), "unreadable-integration\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const binary = installBinary(base, releaseSha256);
    const root = join(base, "Code");
    const state = join(base, "state");
    const hub = join(base, "hub");
    const config = join(root, ".codefoldersync", "config.json");
    createTree(root, "unreadable");
    const blocked = join(root, "blocked");
    mkdirSync(blocked, { mode: 0o700 });
    writeFileSync(join(blocked, "private.ts"), "export const value = 1;\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const run = (args: readonly string[]) =>
      spawnSync(binary, args, { encoding: "utf8" });
    try {
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
        "unreadable-integration",
      ]);
      assert.equal(setup.status, 0, setup.stderr);
      chmodSync(blocked, 0o000);
      const sealed = run(["adoption", "seal", "--config", config]);
      assert.equal(sealed.status, 2);
      assert.match(sealed.stderr, /EACCES|permission denied/iu);
      const status = run(["status", "--config", config]);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).hubSequence, 0);
      assert.equal(
        readFileSync(join(root, "src", "value.ts"), "utf8"),
        "export const value = 'unreadable';\n",
      );
    } finally {
      chmodSync(blocked, 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("large recursive snapshot has a zero-upload no-change pass", () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-large-"));
  const releaseSha256 = "2".repeat(64);
  writeFileSync(join(base, "SENTINEL"), "large-integration\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    const binary = installBinary(base, releaseSha256);
    const root = join(base, "Code");
    const state = join(base, "state");
    const hub = join(base, "hub");
    const config = join(root, ".codefoldersync", "config.json");
    for (let directory = 0; directory < 32; directory += 1) {
      const current = join(root, "packages", `package-${directory}`, "src");
      mkdirSync(current, { recursive: true, mode: 0o700 });
      for (let file = 0; file < 128; file += 1)
        writeFileSync(
          join(current, `file-${file}.ts`),
          `export const value${file} = ${directory * 128 + file};\n`,
          { encoding: "utf8", mode: 0o600 },
        );
    }
    const run = (args: readonly string[]) =>
      spawnSync(binary, args, { encoding: "utf8" });
    assert.equal(
      run([
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
        "large-integration",
      ]).status,
      0,
    );
    const sealed = run(["adoption", "seal", "--config", config]);
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.ok(JSON.parse(sealed.stdout).scanned >= 4_160);
    assert.equal(
      run(["adoption", "cutover", "--approve", "--config", config]).status,
      0,
    );
    const noChange = run(["sync", "--config", config]);
    assert.equal(noChange.status, 0, noChange.stderr);
    assert.equal(JSON.parse(noChange.stdout).uploadedObjects, 0);
    const verified = run(["verify", "--full", "--config", config]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).status, "clean");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "real Linux write and fsync failures retain recovery state and resume cleanly",
  {
    skip:
      platform() !== "linux" ||
      spawnSync("cc", ["--version"], { stdio: "ignore" }).status !== 0,
  },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-fs-fault-"));
    const releaseSha256 = "3".repeat(64);
    try {
      const binary = installBinary(base, releaseSha256);
      const preload = join(base, "filesystem-fault.so");
      const compiled = spawnSync(
        "cc",
        [
          "-shared",
          "-fPIC",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-o",
          preload,
          join(process.cwd(), "test", "fixtures", "filesystem-fault.c"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(compiled.status, 0, compiled.stderr);

      for (const fault of ["enospc-write", "eio-fsync"] as const) {
        const spec = createOneTargetSpec(
          base,
          `real-${fault}`,
          binary,
          releaseSha256,
        );
        const executor = new ProcessDistributedExecutor();
        const prepared = await prepareDistributedSetupV3(spec, executor);
        const adoptionId = prepared.targets[0]?.adoptionId;
        assert.ok(adoptionId);
        await applyDistributedTargetV3(spec, executor, "target", adoptionId);
        await cutoverDistributedAcceptanceV3(spec, executor);

        const authorityValue = join(spec.authority.root, "src", "value.ts");
        const targetValue = join(spec.targets[0]!.root, "src", "value.ts");
        const expected = `export const value = '${fault} recovered';\n`;
        writeFileSync(authorityValue, expected, {
          encoding: "utf8",
          mode: 0o600,
        });
        const authoritySync = spawnSync(
          binary,
          ["sync", "--config", spec.authority.configPath],
          { encoding: "utf8" },
        );
        assert.equal(authoritySync.status, 0, authoritySync.stderr);

        const failed = spawnSync(
          binary,
          ["sync", "--config", spec.targets[0]!.configPath],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              LD_PRELOAD: preload,
              CODEFOLDERSYNC_TEST_FS_FAULT: fault,
              CODEFOLDERSYNC_TEST_FS_MATCH: join(
                spec.targets[0]!.stateDir,
                "staging",
              ),
            },
          },
        );
        assert.equal(failed.status, 1, failed.stderr);
        const failure = JSON.parse(failed.stdout) as {
          readonly status: string;
          readonly reasons: readonly string[];
        };
        assert.equal(failure.status, "inconclusive");
        assert.match(
          failure.reasons.join("\n"),
          fault === "enospc-write"
            ? /ENOSPC|no space left/iu
            : /EIO|I\/O error|input\/output error/iu,
        );
        if (existsSync(targetValue))
          assert.notEqual(readFileSync(targetValue, "utf8"), expected);
        const recoveryRoot = join(spec.targets[0]!.stateDir, "apply-recovery");
        const recoveredValue = readdirSync(recoveryRoot, {
          recursive: true,
          encoding: "utf8",
        }).find((path) => path.endsWith(join("src", "value.ts")));
        assert.ok(recoveredValue);
        assert.equal(
          readFileSync(join(recoveryRoot, recoveredValue), "utf8"),
          "export const value = 'source';\n",
        );

        const resumed = spawnSync(
          binary,
          ["sync", "--config", spec.targets[0]!.configPath],
          { encoding: "utf8" },
        );
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(readFileSync(targetValue, "utf8"), expected);
        const verified = spawnSync(
          binary,
          ["verify", "--full", "--config", spec.targets[0]!.configPath],
          { encoding: "utf8" },
        );
        assert.equal(verified.status, 0, verified.stderr);
        assert.equal(JSON.parse(verified.stdout).status, "clean");
        assert.equal(
          readFileSync(join(recoveryRoot, recoveredValue), "utf8"),
          "export const value = 'source';\n",
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("pseudo-fleet acceptance runs twice from fresh full-tree copies with one deterministic cassette", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-pseudo-fleet-"));
  const runId = "pseudo-fleet-integration-001";
  const releaseSha256 = "c".repeat(64);
  try {
    const binary = installBinary(base, releaseSha256);
    const runRoot = join(base, "run");
    mkdirSync(runRoot, { mode: 0o700 });
    writeFileSync(join(runRoot, "SENTINEL"), `${runId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const masterInputs = [
      ["mattbook", "source"],
      ["wootbook", "woot"],
      ["workermacair", "worker"],
    ] as const;
    const masters = [];
    for (const [machineId, value] of masterInputs) {
      const root = join(base, "masters", machineId, "Code");
      createTree(root, value);
      masters.push({ machineId, root, witness: await createTreeWitness(root) });
    }
    const spec: PseudoFleetAcceptanceSpec = {
      schemaVersion: 1,
      runId,
      scenarioId: "realistic-replay",
      seed: "fixed-realistic-seed",
      repetitions: 2,
      runRoot,
      expectedVersion: "0.3.0",
      expectedReleaseSha256: releaseSha256,
      command: [binary],
      backupWitness: "verified-pseudo-backup",
      sourceMachineId: "mattbook",
      targetOrder: ["wootbook", "workermacair"],
      hubMachineId: "wootbook",
      masters,
    };
    const results = await runPseudoFleetAcceptanceV3(spec);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.passed, true);
    assert.equal(results[1]?.passed, true);
    assert.equal(
      results[0]?.workload.cassetteDigest,
      results[1]?.workload.cassetteDigest,
    );
    assert.equal(results[0]?.workload.files, 64);
    assert.equal(results[1]?.workload.directories, 8);
    assert.notEqual(results[0]?.sourceDigest, "");
    assert.equal(
      existsSync(
        join(runRoot, "realistic-replay-01", "evidence", "result.json"),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(runRoot, "realistic-replay-02", "evidence", "result.json"),
      ),
      true,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AI workload records a large multi-directory mutation and replays it exactly", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-ai-workload-"));
  const runId = "ai-workload-integration-001";
  try {
    writeFileSync(join(base, "SENTINEL"), `${runId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const workspace = join(base, "live-model-workspace");
    createAiWorkloadFixture(workspace);
    const writer = join(base, "writer.mjs");
    writeFileSync(writer, deterministicAiWriterProgram(), {
      encoding: "utf8",
      mode: 0o700,
      flag: "wx",
    });
    const evidence = join(base, "private-evidence");
    const visibility: VisibilityEvent[] = [];
    const observerController = new AbortController();
    let observerReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      observerReady = resolve;
    });
    const observer = runVisibilityObserver(
      {
        schemaVersion: 1,
        runId,
        allowedRunRoot: base,
        workspace,
        timeoutMs: 30_000,
        pollIntervalMs: 10,
      },
      (event) => {
        visibility.push(event);
        if (event.kind === "ready") observerReady?.();
      },
      observerController.signal,
    );
    await ready;
    const result = await runAiWriter({
      runId,
      allowedRunRoot: base,
      workspace,
      privateEvidenceDir: evidence,
      command: [process.execPath, writer],
      modelId: "deterministic-test-writer",
      prompt: aiWorkloadPrompt,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
    });
    assert.equal(result.passed, true);
    assert.ok(result.changedCodeFiles >= 50);
    assert.ok(result.changedDirectories >= 8);
    assert.ok(result.createdFiles >= 2);
    assert.ok(result.deletedFiles >= 2);
    const observationDeadline = Date.now() + 5_000;
    while (
      (!result.finalPathStates.every((expected) =>
        visibility.some(
          (event) =>
            event.kind === "change" &&
            event.pathHash === expected.pathHash &&
            event.stateDigest === expected.stateDigest,
        ),
      ) ||
        !visibility.some(
          (event) =>
            event.kind === "change" && event.treeDigest === result.finalDigest,
        )) &&
      Date.now() < observationDeadline
    )
      await delay(10);
    observerController.abort();
    await observer;
    assert.equal(
      result.finalPathStates.every((expected) =>
        visibility.some(
          (event) =>
            event.kind === "change" &&
            event.pathHash === expected.pathHash &&
            event.stateDigest === expected.stateDigest,
        ),
      ),
      true,
    );
    assert.equal(
      visibility.some(
        (event) =>
          event.kind === "change" && event.treeDigest === result.finalDigest,
      ),
      true,
    );

    const replay = join(base, "replay-workspace");
    createAiWorkloadFixture(replay);
    const replayed = replayAiMutationCassette(
      join(evidence, "ai-mutation-cassette.json"),
      replay,
    );
    assert.equal(replayed.finalDigest, result.finalDigest);
    assert.ok(replayed.operations >= 50);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("distributed setup resumes after a lost response at every remote mutation boundary", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-lost-response-"));
  const releaseSha256 = "d".repeat(64);
  try {
    const binary = installBinary(base, releaseSha256);
    const preparationFaults = [
      "setupAuthority",
      "prepareEnrollment",
      "enrollPeer",
      "activatePeer",
      "sealSource",
      "planAdoption",
    ] as const;
    for (const point of preparationFaults) {
      const spec = createOneTargetSpec(base, point, binary, releaseSha256);
      const executor = new ProcessDistributedExecutor();
      await assert.rejects(
        prepareDistributedSetupV3(spec, loseOneResponse(executor, point)),
        new RegExp(`lost response after ${point}`, "u"),
      );
      const resumed = await prepareDistributedSetupV3(spec, executor);
      assert.equal(resumed.prepared, true);
      assert.equal(resumed.targets[0]?.adoptionId === null, false);
    }

    for (const point of ["applyAdoption", "verify"] as const) {
      const spec = createOneTargetSpec(base, point, binary, releaseSha256);
      const executor = new ProcessDistributedExecutor();
      const prepared = await prepareDistributedSetupV3(spec, executor);
      const adoptionId = prepared.targets[0]?.adoptionId;
      assert.ok(adoptionId);
      await assert.rejects(
        applyDistributedTargetV3(
          spec,
          loseOneResponse(executor, point),
          "target",
          adoptionId,
        ),
        new RegExp(`lost response after ${point}`, "u"),
      );
      const resumed = await applyDistributedTargetV3(
        spec,
        executor,
        "target",
        adoptionId,
      );
      assert.equal(resumed.cutoverReady, true);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function createTree(root: string, value: string): void {
  mkdirSync(join(root, "src"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "src", "value.ts"),
    `export const value = '${value}';\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  writeFileSync(join(root, `${value}.txt`), `${value} only\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installBinary(base: string, releaseSha256: string): string {
  const installRoot = join(base, "installed-lib");
  const binDir = join(base, "installed-bin");
  const install = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "product-cli.js"),
      "install",
      "--built",
      join(process.cwd(), "dist"),
      "--install-root",
      installRoot,
      "--bin-dir",
      binDir,
      "--release-sha256",
      releaseSha256,
    ],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr);
  return join(binDir, "codefoldersync");
}

function deterministicAiWriterProgram(): string {
  return `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
mkdirSync(join(root, "src", "shared"), { recursive: true });
writeFileSync(join(root, "src", "shared", "request-context.ts"), "export interface RequestContext { requestId: string }\\n");
writeFileSync(join(root, "src", "shared", "context-id.ts"), "export const contextId = (context: { requestId: string }) => context.requestId;\\n");
for (let domain = 0; domain < 8; domain += 1) {
  for (let handler = 0; handler < 8; handler += 1) {
    const path = join(root, "src", "domains", \`domain-\${domain}\`, \`handler-\${handler}.ts\`);
    const source = readFileSync(path, "utf8")
      .replace("(input: string)", "(context: RequestContext, input: string)")
      .replace("  return ", "  void context.requestId;\\n  return ");
    writeFileSync(path, \`import type { RequestContext } from "../../shared/request-context.js";\\n\${source}\`);
  }
}
rmSync(join(root, "src", "legacy", "context.ts"));
rmSync(join(root, "src", "legacy", "obsolete.ts"));
`;
}

function createOneTargetSpec(
  base: string,
  point: string,
  binary: string,
  releaseSha256: string,
): DistributedFleetSpec {
  const root = join(base, point);
  const authorityRoot = join(root, "authority", "Code");
  const targetRoot = join(root, "target", "Code");
  createTree(authorityRoot, "source");
  createTree(targetRoot, "target");
  const machine = (machineId: string, codeRoot: string) => ({
    machineId,
    peerName: machineId,
    endpoint: { kind: "local" as const },
    command: [binary],
    root: codeRoot,
    stateDir: join(root, machineId, "state"),
    configPath: join(codeRoot, ".codefoldersync", "config.json"),
  });
  return {
    schemaVersion: 1,
    runId: `lost-response-${point}`,
    expectedVersion: "0.3.0",
    expectedReleaseSha256: releaseSha256,
    folderName: `lost-response-${point}`,
    backupWitness: "verified-lost-response-backup",
    controllerStateDir: join(root, "controller"),
    hub: { kind: "local", path: join(root, "hub") },
    authority: machine("authority", authorityRoot),
    targets: [
      {
        ...machine("target", targetRoot),
        role: "hub",
        requestPath: join(root, "target", "request.json"),
      },
    ],
  };
}

function loseOneResponse(
  delegate: DistributedExecutor,
  point:
    | "setupAuthority"
    | "prepareEnrollment"
    | "enrollPeer"
    | "activatePeer"
    | "sealSource"
    | "planAdoption"
    | "applyAdoption"
    | "verify",
): DistributedExecutor {
  let injected = false;
  const after = async <Result>(
    candidate: typeof point,
    promise: Promise<Result>,
  ): Promise<Result> => {
    const result = await promise;
    if (!injected && candidate === point) {
      injected = true;
      throw new Error(`lost response after ${point}`);
    }
    return result;
  };
  return {
    inspect: (machine) => delegate.inspect(machine),
    setupAuthority: (machine, input) =>
      after("setupAuthority", delegate.setupAuthority(machine, input)),
    prepareEnrollment: (machine, acceptedConfig) =>
      after(
        "prepareEnrollment",
        delegate.prepareEnrollment(machine, acceptedConfig),
      ),
    enrollPeer: (machine, request) =>
      after("enrollPeer", delegate.enrollPeer(machine, request)),
    activatePeer: (machine, acceptedConfig, request) =>
      after(
        "activatePeer",
        delegate.activatePeer(machine, acceptedConfig, request),
      ),
    sealSource: (machine, config) =>
      after("sealSource", delegate.sealSource(machine, config)),
    planAdoption: (machine, config, adoptionId) =>
      after("planAdoption", delegate.planAdoption(machine, config, adoptionId)),
    applyAdoption: (machine, config, adoptionId) =>
      after(
        "applyAdoption",
        delegate.applyAdoption(machine, config, adoptionId),
      ),
    verify: (machine, config) =>
      after("verify", delegate.verify(machine, config)),
    cutover: (machine, config) => delegate.cutover(machine, config),
  };
}
