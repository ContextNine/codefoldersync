import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { doctor } from "./doctor.js";
import { runOnPeer, runOnPeerAsync } from "./executor.js";
import { LeaseGuard } from "./guard.js";
import { DurableJournal, readJournal } from "./journal.js";
import { resolveRunPaths, validateRunRoot } from "./paths.js";
import { runCommand } from "./process.js";
import { productVersion } from "./v2/service.js";
import {
  peerNames,
  repositoryNames,
  type HarnessConfig,
  type JournalEntry,
  type PeerConfig,
  type PeerName,
  type RepositoryName,
  type ScenarioMode,
  type ScenarioName,
  type ScenarioResult,
  type VerificationResult,
} from "./types.js";
import { enforcePeerAgreement } from "./verifier.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RemoteOperationResult {
  readonly token?: string;
  readonly digest?: string;
  readonly commitOid?: string;
  readonly refName?: string;
  readonly backupRef?: string;
}

interface SnapshotResult {
  readonly manifestDigest: string;
  readonly gitSemanticDigest: string;
  readonly repositories: Readonly<
    Record<RepositoryName, { readonly valid: boolean }>
  >;
}

interface ProductSyncResult {
  readonly unit: string;
  readonly action: string;
  readonly snapshotId?: string;
  readonly reason?: string;
}

export function prepareLive(
  config: HarnessConfig,
  runId: string,
  seed: number,
): Readonly<Record<PeerName, unknown>> {
  const readiness = doctor(config);
  const blocked = readiness.filter((result) => !result.ready);
  if (blocked.length > 0) {
    throw new Error(
      `Fleet readiness failed: ${blocked
        .map((result) => `${result.peer}(${result.issues.join(",")})`)
        .join(" ")}`,
    );
  }
  runCommand("corepack", ["pnpm", "build"], { cwd: sourceRoot });
  const dist = join(sourceRoot, "dist");
  const capabilities = {} as Record<PeerName, unknown>;
  for (const peer of config.peers) {
    bootstrapRunRoot(peer, runId);
    deployWorker(peer, runId, dist);
    capabilities[peer.name] = runWorkerJson(peer, runId, "capabilities", []);
    const version = runProduct(peer, runId, ["--version"]);
    if (version.stdout.trim() !== `codefoldersync ${productVersion}`) {
      throw new Error(
        `Unexpected product build on ${peer.name}: ${version.stdout.trim()}`,
      );
    }
  }
  const alpha = findPeer(config, "alpha");
  runWorkerJson(alpha, runId, "fixture", ["--seed", String(seed)]);
  const paths = validateRunRoot(alpha.runBase, runId);
  writeFileSync(
    join(paths.control, "preparation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        seed,
        productVersion: "0.1.0",
        preparedAt: new Date().toISOString(),
        readiness,
        capabilities,
      },
      null,
      2,
    )}\n`,
  );
  return capabilities;
}

export async function configureLive(
  config: HarnessConfig,
  runId: string,
): Promise<string> {
  const gamma = findPeer(config, "gamma");
  const gammaPaths = validateRemoteRunRoot(gamma, runId);
  const hubPath = join(gammaPaths.control, "hub");
  const alpha = findPeer(config, "alpha");
  const alphaSetup = setupPeer(alpha, gamma, runId, hubPath, "create");
  const folderId = requiredJsonString(alphaSetup, "folderId");
  for (const peer of config.peers.filter(
    (candidate) => candidate.name !== "alpha",
  )) {
    setupPeer(peer, gamma, runId, hubPath, "join", folderId);
  }
  for (const peer of config.peers)
    assertProductSync(runProductSync(peer, runId));
  await waitForConvergence(config, runId);
  return folderId;
}

export function closeLive(config: HarnessConfig, runId: string): void {
  for (const peer of config.peers) {
    validateRemoteRunRoot(peer, runId);
    const status = runProduct(peer, runId, [
      "status",
      "--config",
      productConfigPath(peer, runId),
    ]);
    if (status.status !== 0) {
      throw new Error(
        `Cannot close ${peer.name}: product state is blocked or inconclusive`,
      );
    }
  }
}

export async function runLiveScenario(input: {
  readonly config: HarnessConfig;
  readonly runId: string;
  readonly scenario: ScenarioName;
  readonly mode: ScenarioMode;
  readonly seed: number;
}): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const alpha = findPeer(input.config, "alpha");
  const alphaPaths = validateRunRoot(alpha.runBase, input.runId);
  const journal = new DurableJournal(
    join(alphaPaths.control, "controller.jsonl"),
  );
  const notes: string[] = [
    "Every product sync used a fresh CLI process; no process-local cache could create convergence.",
  ];
  let verification: Readonly<Record<PeerName, VerificationResult>> | undefined;
  let failure: string | undefined;
  try {
    switch (input.scenario) {
      case "serial":
        await liveSerial(input.config, input.runId, journal);
        break;
      case "conflict":
        verification = await liveConflict(
          input.config,
          input.runId,
          input.mode,
          journal,
          notes,
        );
        break;
      case "churn":
        await liveChurn(input.config, input.runId, input.mode, journal, notes);
        break;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    notes.push(`failure: ${failure}`);
  } finally {
    journal.close();
  }

  if (failure === undefined) {
    try {
      await waitForConvergence(input.config, input.runId);
      verification ??= collectVerification(input.config, input.runId);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      notes.push(`verification failure: ${failure}`);
    }
  }

  const finalVerification =
    verification ?? failedVerification(failure ?? "unknown failure");
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    mode: input.mode,
    adapter: "codefoldersync",
    seed: input.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict:
      failure === undefined && verificationPassed(finalVerification)
        ? "pass"
        : failure?.includes("timeout")
          ? "inconclusive-timeout"
          : "product-failure",
    verification: finalVerification,
    notes,
  };
}

export async function verifyLive(
  config: HarnessConfig,
  runId: string,
): Promise<Readonly<Record<PeerName, VerificationResult>>> {
  await waitForConvergence(config, runId);
  return collectVerification(config, runId);
}

async function liveSerial(
  config: HarnessConfig,
  runId: string,
  journal: DurableJournal,
): Promise<void> {
  for (const peerName of peerNames) {
    const peer = findPeer(config, peerName);
    for (const repository of repositoryNames) {
      runWrite(
        peer,
        runId,
        repository,
        `serial-${peerName}-${repository}-file`,
        `handoff/${peerName}.txt`,
        journal,
      );
      runWrite(
        peer,
        runId,
        repository,
        `serial-${peerName}-${repository}-executable`,
        `bin/run-${peerName}.sh`,
        journal,
      );
      runWorkerJson(peer, runId, "chmod-executable", [
        "--peer",
        peerName,
        "--repository",
        repository,
        "--path",
        `bin/run-${peerName}.sh`,
      ]);
      runCommit(
        peer,
        runId,
        repository,
        `serial-${peerName}-${repository}-commit`,
        `serial/${peerName}`,
        `commits/${peerName}.txt`,
        journal,
      );
    }
    assertProductSync(runProductSync(peer, runId));
    for (const target of config.peers.filter(
      (candidate) => candidate.name !== peerName,
    )) {
      assertProductSync(runProductSync(target, runId));
    }
    await waitForConvergence(config, runId);
  }
}

async function liveConflict(
  config: HarnessConfig,
  runId: string,
  mode: ScenarioMode,
  journal: DurableJournal,
  notes: string[],
): Promise<Readonly<Record<PeerName, VerificationResult>>> {
  if (mode === "guarded") {
    exerciseLiveGuard(config, runId, journal, notes);
    await waitForConvergence(config, runId);
    return collectVerification(config, runId);
  }

  const expected = {} as Record<
    PeerName,
    {
      readonly write: RemoteOperationResult;
      readonly commit: RemoteOperationResult;
    }
  >;
  for (const peerName of peerNames) {
    const peer = findPeer(config, peerName);
    expected[peerName] = {
      write: runWrite(
        peer,
        runId,
        "atlas",
        `conflict-${peerName}-shared`,
        "src/shared.txt",
        journal,
      ),
      commit: runCommit(
        peer,
        runId,
        "atlas",
        `conflict-${peerName}-commit`,
        `conflict/${peerName}`,
        `commits/${peerName}.txt`,
        journal,
      ),
    };
  }

  const snapshots = {} as Record<PeerName, string>;
  const alphaResult = runProductSync(findPeer(config, "alpha"), runId);
  assertProductSync(alphaResult);
  snapshots.alpha = requiredSnapshot(alphaResult, "atlas", "published");
  for (const peerName of ["gamma", "beta"] as const) {
    const result = runProductSync(findPeer(config, peerName), runId, true);
    snapshots[peerName] = requiredSnapshot(result, "atlas", "blocked");
  }

  for (const peerName of peerNames) {
    const peer = findPeer(config, peerName);
    const recovered = join(
      resolveRunPaths(peer.runBase, runId).control,
      "recovered",
      snapshots[peerName],
    );
    const recovery = runProduct(peer, runId, [
      "recover",
      snapshots[peerName],
      "--to",
      recovered,
      "--config",
      productConfigPath(peer, runId),
    ]);
    if (recovery.status !== 0)
      throw new Error(`Recovery failed on ${peerName}`);
    validateRecoveredConflict(peer, recovered, expected[peerName]);
  }

  const gammaResolution = runProduct(findPeer(config, "gamma"), runId, [
    "resolve",
    "atlas",
    "--take",
    "remote",
    "--config",
    productConfigPath(findPeer(config, "gamma"), runId),
  ]);
  if (gammaResolution.status !== 0)
    throw new Error("Gamma remote resolution failed");
  const betaResolution = runProduct(findPeer(config, "beta"), runId, [
    "resolve",
    "atlas",
    "--take",
    "local",
    "--config",
    productConfigPath(findPeer(config, "beta"), runId),
  ]);
  if (betaResolution.status !== 0)
    throw new Error("Beta local resolution failed");
  notes.push(
    "All three divergent atlas repositories were recovered and Git-validated before explicit remote/local resolution.",
  );
  await waitForConvergence(config, runId);
  return preservationVerification(config, runId, 6);
}

function exerciseLiveGuard(
  config: HarnessConfig,
  runId: string,
  journal: DurableJournal,
  notes: string[],
): void {
  const guard = new LeaseGuard();
  const baseline = runSnapshot(findPeer(config, "alpha"), runId).manifestDigest;
  const lease = guard.acquire({
    repository: "atlas",
    holder: "alpha",
    baselineDigest: baseline,
    now: Date.now(),
    ttlMs: 30_000,
    allPeersReady: true,
    hasConflict: false,
  });
  assertGuardDenial(guard, baseline);
  const alpha = findPeer(config, "alpha");
  const alphaPaths = validateRunRoot(alpha.runBase, runId);
  const operationId = "guarded-heartbeat-expiry";
  const relativePath = "guard/must-not-complete.txt";
  journal.append(
    controllerEntry(runId, "alpha", "atlas", operationId, "write", "planned", {
      relativePath,
    }),
  );
  durableWrite(
    join(alphaPaths.control, "guard-heartbeat.json"),
    `${JSON.stringify({ expiresAt: Date.now() + 300 })}\n`,
  );
  runWorkerJson(alpha, runId, "supervise-expiry-probe", [
    "--peer",
    "alpha",
    "--repository",
    "atlas",
    "--operation",
    operationId,
    "--path",
    relativePath,
    "--heartbeat",
    "guard-heartbeat.json",
    "--child-delay-ms",
    "3000",
  ]);
  journal.append(
    controllerEntry(
      runId,
      "alpha",
      "atlas",
      operationId,
      "write",
      "interrupted",
      {
        relativePath,
        detail: "controller-heartbeat-expired",
      },
    ),
  );
  if (existsSync(join(alphaPaths.workspace, "atlas", relativePath))) {
    throw new Error("Heartbeat-expired writer mutated the repository");
  }
  runWrite(
    alpha,
    runId,
    "atlas",
    "guarded-alpha-shared",
    "src/shared.txt",
    journal,
  );
  guard.release(lease);
  notes.push(
    "Guard denied the competing writer and killed the expired writer before mutation.",
  );
}

async function liveChurn(
  config: HarnessConfig,
  runId: string,
  mode: ScenarioMode,
  journal: DurableJournal,
  notes: string[],
): Promise<void> {
  if (mode === "guarded") {
    notes.push("Repo-scoped owners: alpha/atlas, beta/birch, gamma/coral.");
  }
  const workloads = peerNames.map(async (peerName, index) => {
    const peer = findPeer(config, peerName);
    const repository = repositoryNames[index];
    if (repository === undefined) throw new Error("Missing churn repository");
    planChurn(runId, peerName, repository, mode, journal);
    const result = await runWorkerJsonAsync(peer, runId, "churn", [
      "--peer",
      peerName,
      "--repository",
      repository,
      "--count",
      "40",
      ...(mode === "guarded" ? ["--guarded"] : []),
    ]);
    for (const operation of parseOperationArray(result)) {
      const evidence = completeChurnEvidence(peerName, operation);
      journal.append(
        controllerEntry(
          runId,
          peerName,
          repository,
          operation.operationId,
          operation.type,
          "completed",
          evidence,
        ),
      );
    }
  });
  await Promise.all(workloads);
  for (const peerName of ["alpha", "gamma", "beta"] as const) {
    assertProductSync(runProductSync(findPeer(config, peerName), runId));
  }
  await waitForConvergence(config, runId);
}

function completeChurnEvidence(
  peer: PeerName,
  operation: RemoteOperationResult & {
    readonly operationId: string;
    readonly type: string;
    readonly kind?: string;
  },
): Partial<JournalEntry> {
  if (operation.type === "delete") {
    return { ...operation, relativePath: "src/nested/file-7.txt" };
  }
  if (operation.type === "commit") {
    return { ...operation, relativePath: `churn/${peer}/committed.txt` };
  }
  const index = Number(operation.operationId.split("-").at(-1));
  if (!Number.isSafeInteger(index))
    throw new Error("Invalid churn operation ID");
  return {
    ...operation,
    relativePath:
      operation.kind === "rename"
        ? `churn/${peer}/renamed-${index}.txt`
        : `churn/${peer}/operation-${index}.txt`,
  };
}

function planChurn(
  runId: string,
  peer: PeerName,
  repository: RepositoryName,
  mode: ScenarioMode,
  journal: DurableJournal,
): void {
  const kinds = [
    "create",
    "rename",
    "chmod",
    "stage",
    "unstage",
    "append",
    "replace",
  ] as const;
  for (let operation = 0; operation < 40; operation += 1) {
    const kind = kinds[operation % kinds.length];
    if (kind === undefined) throw new Error("Invalid churn operation kind");
    journal.append(
      controllerEntry(
        runId,
        peer,
        repository,
        `churn-${peer}-${operation}`,
        kind === "rename" || kind === "append" || kind === "replace"
          ? kind
          : "write",
        "planned",
        {
          relativePath:
            kind === "rename"
              ? `churn/${peer}/renamed-${operation}.txt`
              : `churn/${peer}/operation-${operation}.txt`,
        },
      ),
    );
  }
  journal.append(
    controllerEntry(
      runId,
      peer,
      repository,
      `churn-${peer}-delete`,
      "delete",
      "planned",
      { relativePath: "src/nested/file-7.txt" },
    ),
  );
  journal.append(
    controllerEntry(
      runId,
      peer,
      repository,
      `churn-${peer}-commit`,
      "commit",
      "planned",
      {
        refName: `refs/heads/churn/${peer}`,
        ...(mode === "guarded"
          ? { backupRef: `refs/codefoldersync/${peer}/churn-${peer}-commit` }
          : {}),
      },
    ),
  );
}

function runWrite(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  operationId: string,
  relativePath: string,
  journal: DurableJournal,
): RemoteOperationResult {
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "write",
      "planned",
      {
        relativePath,
      },
    ),
  );
  const result = runWorkerJson(peer, runId, "write", [
    "--peer",
    peer.name,
    "--repository",
    repository,
    "--operation",
    operationId,
    "--path",
    relativePath,
  ]) as RemoteOperationResult;
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "write",
      "completed",
      {
        relativePath,
        ...result,
      },
    ),
  );
  return result;
}

function runCommit(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  operationId: string,
  branch: string,
  relativePath: string,
  journal: DurableJournal,
): RemoteOperationResult {
  const refName = `refs/heads/${branch}`;
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "commit",
      "planned",
      {
        relativePath,
        refName,
      },
    ),
  );
  const result = runWorkerJson(peer, runId, "commit", [
    "--peer",
    peer.name,
    "--repository",
    repository,
    "--operation",
    operationId,
    "--branch",
    branch,
    "--path",
    relativePath,
  ]) as RemoteOperationResult;
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "commit",
      "completed",
      {
        relativePath,
        refName,
        ...result,
      },
    ),
  );
  return result;
}

function controllerEntry(
  runId: string,
  peer: PeerName,
  repository: RepositoryName,
  operationId: string,
  action: string,
  phase: JournalEntry["phase"],
  evidence: Partial<JournalEntry>,
): JournalEntry {
  return {
    schemaVersion: 1,
    runId,
    operationId,
    timestamp: new Date().toISOString(),
    peer,
    repository,
    action,
    phase,
    source: "controller",
    ...evidence,
  };
}

function setupPeer(
  peer: PeerConfig,
  gamma: PeerConfig,
  runId: string,
  hubPath: string,
  mode: "create" | "join",
  folderId?: string,
): unknown {
  const paths = validateRemoteRunRoot(peer, runId);
  const gammaPaths = validateRemoteRunRoot(gamma, runId);
  const localHub = gamma.host === "local" || peer.name === gamma.name;
  const hub = localHub ? hubPath : `ssh://${gamma.host}${hubPath}`;
  const args = [
    "setup",
    "--mode",
    mode,
    "--root",
    paths.workspace,
    "--hub",
    hub,
    "--name",
    `codefoldersync-${runId}`,
    "--peer",
    peer.name,
    "--state",
    join(paths.control, "product-state"),
    "--config",
    productConfigPath(peer, runId),
    ...(folderId === undefined ? [] : ["--folder-id", folderId]),
    ...(localHub
      ? []
      : [
          "--remote-node",
          gamma.nodeBinary,
          "--remote-command",
          join(gammaPaths.tools, "product-cli.js"),
        ]),
  ];
  const result = runProduct(peer, runId, args);
  if (result.status !== 0) {
    throw new Error(
      `Product setup failed on ${peer.name}: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout) as unknown;
}

function runProductSync(
  peer: PeerConfig,
  runId: string,
  allowFailure = false,
): readonly ProductSyncResult[] {
  const result = runProduct(
    peer,
    runId,
    ["sync", "--config", productConfigPath(peer, runId)],
    allowFailure,
  );
  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value)) throw new Error("Invalid product sync result");
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("unit" in entry) ||
      typeof entry.unit !== "string" ||
      !("action" in entry) ||
      typeof entry.action !== "string"
    ) {
      throw new Error("Invalid product sync entry");
    }
    return entry as ProductSyncResult;
  });
}

function runProduct(
  peer: PeerConfig,
  runId: string,
  args: readonly string[],
  allowFailure = false,
) {
  const paths = resolveRunPaths(peer.runBase, runId);
  return runOnPeer(
    peer,
    peer.nodeBinary,
    [join(paths.tools, "product-cli.js"), ...args],
    allowFailure,
  );
}

function assertProductSync(results: readonly ProductSyncResult[]): void {
  const failed = results.filter(
    (result) => result.action === "blocked" || result.action === "inconclusive",
  );
  if (failed.length > 0)
    throw new Error(`Product sync did not converge: ${JSON.stringify(failed)}`);
}

function requiredSnapshot(
  results: readonly ProductSyncResult[],
  unit: string,
  action: string,
): string {
  const result = results.find((candidate) => candidate.unit === unit);
  if (result?.action !== action || result.snapshotId === undefined) {
    throw new Error(
      `Expected ${unit} ${action}, got ${JSON.stringify(result)}`,
    );
  }
  return result.snapshotId;
}

async function waitForConvergence(
  config: HarnessConfig,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + config.convergenceTimeoutMs;
  let matching = 0;
  let previous = "";
  const trace: Array<{
    readonly peer: PeerName;
    readonly results: readonly ProductSyncResult[];
  }> = [];
  while (Date.now() < deadline) {
    for (const peer of config.peers) {
      try {
        const results = runProductSync(peer, runId, true);
        trace.push({ peer: peer.name, results });
        if (trace.length > 12) trace.shift();
        assertProductSync(results);
      } catch (error) {
        throw new Error(
          `${peer.name}: ${error instanceof Error ? error.message : String(error)}; trace=${JSON.stringify(trace)}`,
        );
      }
    }
    const snapshots = config.peers.map((peer) => runSnapshot(peer, runId));
    const combined = snapshots.map(
      (snapshot) => `${snapshot.manifestDigest}:${snapshot.gitSemanticDigest}`,
    );
    const valid = snapshots.every((snapshot) =>
      Object.values(snapshot.repositories).every(
        (repository) => repository.valid,
      ),
    );
    if (new Set(combined).size === 1 && valid) {
      const digest = combined[0] ?? "";
      matching = digest === previous ? matching + 1 : 1;
      previous = digest;
      if (matching >= config.quietSamples) return;
    } else {
      matching = 0;
      previous = "";
    }
    await delay(config.quietIntervalMs);
  }
  throw new Error("convergence timeout");
}

function collectVerification(
  config: HarnessConfig,
  runId: string,
): Readonly<Record<PeerName, VerificationResult>> {
  const alpha = findPeer(config, "alpha");
  const alphaPaths = validateRunRoot(alpha.runBase, runId);
  const controllerPath = join(alphaPaths.control, "controller.jsonl");
  const aggregateEntries: string[] = [];
  for (const peer of config.peers) {
    const paths = validateRemoteRunRoot(peer, runId);
    aggregateEntries.push(
      runOnPeer(peer, "/bin/cat", [
        join(paths.control, "peer.jsonl"),
      ]).stdout.trimEnd(),
    );
  }
  const aggregatePath = join(alphaPaths.control, "peer-aggregate.jsonl");
  durableWrite(
    aggregatePath,
    `${aggregateEntries.filter(Boolean).join("\n")}\n`,
  );
  const verification = {} as Record<PeerName, VerificationResult>;
  for (const peer of config.peers) {
    const paths = validateRemoteRunRoot(peer, runId);
    if (peer.name !== "alpha" && peer.host === "local") {
      cpSync(controllerPath, join(paths.control, "controller.jsonl"));
      cpSync(aggregatePath, join(paths.control, "peer-aggregate.jsonl"));
    } else if (peer.host !== "local") {
      runCommand("scp", [
        "-q",
        controllerPath,
        `${peer.host}:${paths.control}/controller.jsonl`,
      ]);
      runCommand("scp", [
        "-q",
        aggregatePath,
        `${peer.host}:${paths.control}/peer-aggregate.jsonl`,
      ]);
    }
    verification[peer.name] = runWorkerJson(peer, runId, "verify", [
      "--controller-journal",
      "controller.jsonl",
      "--peer-journal",
      "peer-aggregate.jsonl",
    ]) as VerificationResult;
  }
  return enforcePeerAgreement(verification);
}

function preservationVerification(
  config: HarnessConfig,
  runId: string,
  requiredOperations: number,
): Readonly<Record<PeerName, VerificationResult>> {
  const snapshots = Object.fromEntries(
    config.peers.map((peer) => [peer.name, runSnapshot(peer, runId)]),
  ) as Record<PeerName, SnapshotResult>;
  const first = snapshots.alpha;
  const agreed = peerNames.every(
    (peer) =>
      snapshots[peer].manifestDigest === first.manifestDigest &&
      snapshots[peer].gitSemanticDigest === first.gitSemanticDigest &&
      Object.values(snapshots[peer].repositories).every(
        (repository) => repository.valid,
      ),
  );
  const result = {} as Record<PeerName, VerificationResult>;
  for (const peer of peerNames) {
    result[peer] = {
      passed: agreed,
      manifestDigest: snapshots[peer].manifestDigest,
      gitSemanticDigest: snapshots[peer].gitSemanticDigest,
      classifications: [
        "repository-divergence-preserved",
        "explicit-resolution",
      ],
      issues: agreed
        ? []
        : [
            {
              code: "peer-divergence",
              message: "Peers did not converge after resolution",
            },
          ],
      requiredOperations,
      recoveredOperations: agreed ? requiredOperations : 0,
    };
  }
  return result;
}

function validateRecoveredConflict(
  peer: PeerConfig,
  recovered: string,
  expected: {
    readonly write: RemoteOperationResult;
    readonly commit: RemoteOperationResult;
  },
): void {
  const digest = runOnPeer(peer, peer.nodeBinary, [
    "-e",
    'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))',
    join(recovered, "src", "shared.txt"),
  ]).stdout;
  if (expected.write.digest === undefined || digest !== expected.write.digest) {
    throw new Error(`Recovered file digest mismatch on ${peer.name}`);
  }
  const refName = expected.commit.refName;
  const commitOid = expected.commit.commitOid;
  if (refName === undefined || commitOid === undefined)
    throw new Error("Commit evidence is incomplete");
  const ref = runOnPeer(peer, "git", [
    "-C",
    recovered,
    "rev-parse",
    "--verify",
    refName,
  ]);
  if (ref.stdout.trim() !== commitOid)
    throw new Error(`Recovered Git ref mismatch on ${peer.name}`);
  runOnPeer(peer, "git", ["-C", recovered, "fsck", "--full"]);
}

function bootstrapRunRoot(peer: PeerConfig, runId: string): void {
  const paths = resolveRunPaths(peer.runBase, runId);
  const sentinel = JSON.stringify({
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
  });
  const script =
    'set -eu; base="$1"; run="$2"; sentinel="$3"; root="$base/$run"; test ! -e "$root"; umask 077; mkdir -p "$root/workspace" "$root/control" "$root/tools"; printf "%s\\n" "$sentinel" > "$root/.codefoldersync-run.json"';
  runOnPeer(peer, "/bin/sh", [
    "-c",
    script,
    "sh",
    peer.runBase,
    runId,
    sentinel,
  ]);
  if (peer.host === "local") validateRunRoot(peer.runBase, runId);
  if (paths.root.length === 0) throw new Error("Invalid run root");
}

function deployWorker(peer: PeerConfig, runId: string, dist: string): void {
  const paths = resolveRunPaths(peer.runBase, runId);
  if (peer.host === "local") {
    for (const name of readdirSync(dist)) {
      cpSync(join(dist, name), join(paths.tools, name), { recursive: true });
    }
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-deploy-"));
  try {
    const archive = join(temporary, "worker.tar.gz");
    const remoteArchive = join(paths.control, "worker.tar.gz");
    runCommand("tar", ["-C", dist, "-czf", archive, "."]);
    runCommand("scp", ["-q", archive, `${peer.host}:${remoteArchive}`]);
    runOnPeer(peer, "tar", ["-C", paths.tools, "-xzf", remoteArchive]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runWorkerJson(
  peer: PeerConfig,
  runId: string,
  command: string,
  args: readonly string[],
): unknown {
  const paths = resolveRunPaths(peer.runBase, runId);
  const result = runOnPeer(peer, peer.nodeBinary, [
    join(paths.tools, "peer-worker.js"),
    command,
    "--run-base",
    peer.runBase,
    "--run",
    runId,
    ...args,
  ]);
  return JSON.parse(result.stdout) as unknown;
}

async function runWorkerJsonAsync(
  peer: PeerConfig,
  runId: string,
  command: string,
  args: readonly string[],
): Promise<unknown> {
  const paths = resolveRunPaths(peer.runBase, runId);
  const result = await runOnPeerAsync(peer, peer.nodeBinary, [
    join(paths.tools, "peer-worker.js"),
    command,
    "--run-base",
    peer.runBase,
    "--run",
    runId,
    ...args,
  ]);
  return JSON.parse(result.stdout) as unknown;
}

function runSnapshot(peer: PeerConfig, runId: string): SnapshotResult {
  return runWorkerJson(peer, runId, "snapshot", []) as SnapshotResult;
}

function validateRemoteRunRoot(peer: PeerConfig, runId: string) {
  const paths = resolveRunPaths(peer.runBase, runId);
  if (peer.host === "local") return validateRunRoot(peer.runBase, runId);
  const result = runOnPeer(peer, "/bin/cat", [
    join(paths.root, ".codefoldersync-run.json"),
  ]);
  const value: unknown = JSON.parse(result.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("runId" in value) ||
    value.runId !== runId
  ) {
    throw new Error(`Remote sentinel mismatch on ${peer.name}`);
  }
  return paths;
}

function productConfigPath(peer: PeerConfig, runId: string): string {
  return join(resolveRunPaths(peer.runBase, runId).control, "product.json");
}

function durableWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertGuardDenial(guard: LeaseGuard, baseline: string): void {
  try {
    guard.acquire({
      repository: "atlas",
      holder: "beta",
      baselineDigest: baseline,
      now: Date.now(),
      ttlMs: 30_000,
      allPeersReady: true,
      hasConflict: false,
    });
    throw new Error("Guard failed to deny competing writer");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("repository-busy"))
      throw error;
  }
}

function requiredJsonString(value: unknown, key: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !(key in value) ||
    typeof value[key as keyof typeof value] !== "string"
  ) {
    throw new Error(`Missing ${key} in product response`);
  }
  return value[key as keyof typeof value] as string;
}

function parseOperationArray(value: unknown): Array<
  RemoteOperationResult & {
    readonly operationId: string;
    readonly type: string;
  }
> {
  if (!Array.isArray(value)) throw new Error("Invalid churn worker output");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("operationId" in item) ||
      typeof item.operationId !== "string" ||
      !("type" in item) ||
      typeof item.type !== "string"
    ) {
      throw new Error("Invalid churn operation output");
    }
    return item as RemoteOperationResult & {
      readonly operationId: string;
      readonly type: string;
    };
  });
}

function verificationPassed(
  verification: Readonly<Record<PeerName, VerificationResult>>,
): boolean {
  return peerNames.every((peer) => verification[peer].passed);
}

function failedVerification(
  reason: string,
): Readonly<Record<PeerName, VerificationResult>> {
  const result = {} as Record<PeerName, VerificationResult>;
  for (const peer of peerNames) {
    result[peer] = {
      passed: false,
      manifestDigest: "",
      gitSemanticDigest: "",
      classifications: ["execution-failure"],
      issues: [{ code: "execution-failure", message: reason, peer }],
      requiredOperations: 0,
      recoveredOperations: 0,
    };
  }
  return result;
}

function findPeer(config: HarnessConfig, name: PeerName): PeerConfig {
  const peer = config.peers.find((candidate) => candidate.name === name);
  if (peer === undefined) throw new Error(`Missing peer ${name}`);
  return peer;
}
