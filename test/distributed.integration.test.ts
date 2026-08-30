import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  prepareDistributedSetupV3,
  type DistributedExecutor,
} from "../src/v3/distributed.js";
import { ProcessDistributedExecutor } from "../src/v3/distributed-process.js";

test("distributed setup previews, prepares, resumes, and applies one approved target at a time", () => {
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
  };
}
