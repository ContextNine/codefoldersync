import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor } from "./doctor.js";
import { runOnPeer, runOnPeerAsync, shellQuote } from "./executor.js";
import { LeaseGuard } from "./guard.js";
import { DurableJournal } from "./journal.js";
import { resolveRunPaths, validateRunRoot } from "./paths.js";
import { runCommand } from "./process.js";
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
  readonly repositories: Readonly<
    Record<RepositoryName, { readonly valid: boolean }>
  >;
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
  const versions = new Set(readiness.map((result) => result.treesyncVersion));
  if (versions.size !== 1)
    throw new Error("All peers must run the same TreeSync version");

  runCommand("corepack", ["pnpm", "build"], { cwd: sourceRoot });
  const dist = join(sourceRoot, "dist");
  const capabilities = {} as Record<PeerName, unknown>;
  for (const peer of config.peers) {
    bootstrapRunRoot(peer, runId);
    deployWorker(peer, runId, dist);
    capabilities[peer.name] = runWorkerJson(peer, runId, "capabilities", []);
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
        preparedAt: new Date().toISOString(),
        versions: readiness.map((result) => ({
          peer: result.peer,
          treesync: result.treesyncVersion,
          git: result.gitVersion,
          node: result.nodeVersion,
        })),
        capabilities,
      },
      null,
      2,
    )}\n`,
  );
  return capabilities;
}

export async function enrollLive(
  config: HarnessConfig,
  runId: string,
): Promise<void> {
  const alpha = findPeer(config, "alpha");
  if (alpha.host !== "local")
    throw new Error("Alpha must be local for non-capturing enrollment");
  const alphaPaths = validateRunRoot(alpha.runBase, runId);
  const alphaStatus = treesyncGlobalStatus(alpha);
  if (alphaStatus.includes("logged in: no")) {
    throw new Error(
      "Alpha is logged out. Complete `treesync login --name treesync-harness-alpha` interactively, then rerun enroll.",
    );
  }
  assertNoExistingFolders(alpha, alphaPaths.workspace);
  if (!folderIsRegistered(alpha, alphaPaths.workspace)) {
    runOnPeer(alpha, alpha.treesyncBinary, [
      "add",
      alphaPaths.workspace,
      "--name",
      `treesync-safety-${runId}`,
    ]);
  }
  runOnPeer(alpha, alpha.treesyncBinary, [
    "push",
    alphaPaths.workspace,
    "--verbose",
  ]);
  runOnPeer(alpha, alpha.treesyncBinary, ["start"]);

  for (const peer of config.peers.filter(
    (candidate) => candidate.name !== "alpha",
  )) {
    const paths = validateRemoteRunRoot(peer, runId);
    const status = treesyncGlobalStatus(peer);
    if (!status.includes("logged in: no")) {
      throw new Error(
        `${peer.name} already has TreeSync account state; refusing link/join to preserve existing registrations`,
      );
    }
    assertNoExistingFolders(peer, paths.workspace);
    await linkWithoutCapture(
      alpha,
      alphaPaths.workspace,
      peer,
      paths.workspace,
    );
  }
  await waitForConvergence(config, runId, peerNames);
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
  const controllerJournal = new DurableJournal(
    join(alphaPaths.control, "controller.jsonl"),
  );
  const notes: string[] = [];
  try {
    switch (input.scenario) {
      case "serial":
        await liveSerial(input.config, input.runId, controllerJournal);
        break;
      case "conflict":
        await liveConflict(
          input.config,
          input.runId,
          input.mode,
          controllerJournal,
          notes,
        );
        break;
      case "churn":
        await liveChurn(
          input.config,
          input.runId,
          input.mode,
          controllerJournal,
          notes,
        );
        break;
    }
  } finally {
    controllerJournal.close();
  }
  await waitForConvergence(input.config, input.runId, peerNames);
  const verification = collectVerification(input.config, input.runId);
  for (const peer of input.config.peers) service(peer, "stop");
  for (const peer of input.config.peers) service(peer, "start");
  await waitForConvergence(input.config, input.runId, peerNames);
  const postRestart = collectVerification(input.config, input.runId);
  const passed = peerNames.every(
    (peer) => verification[peer].passed && postRestart[peer].passed,
  );
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    mode: input.mode,
    adapter: "treesync",
    seed: input.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: passed ? "pass" : "product-failure",
    verification: postRestart,
    notes,
  };
}

export async function verifyLive(
  config: HarnessConfig,
  runId: string,
): Promise<Readonly<Record<PeerName, VerificationResult>>> {
  await waitForConvergence(config, runId, peerNames);
  return collectVerification(config, runId);
}

async function liveSerial(
  config: HarnessConfig,
  runId: string,
  journal: DurableJournal,
): Promise<void> {
  for (const peer of config.peers) service(peer, "stop");
  const active: PeerName[] = [];
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
    service(peer, "start");
    active.push(peerName);
    await waitForConvergence(config, runId, active);
  }
}

async function liveConflict(
  config: HarnessConfig,
  runId: string,
  mode: ScenarioMode,
  journal: DurableJournal,
  notes: string[],
): Promise<void> {
  for (const peer of config.peers) service(peer, "stop");
  if (mode === "guarded") {
    const guard = new LeaseGuard();
    const snapshot = runSnapshot(findPeer(config, "alpha"), runId);
    const lease = guard.acquire({
      repository: "atlas",
      holder: "alpha",
      baselineDigest: snapshot.manifestDigest,
      now: Date.now(),
      ttlMs: 30_000,
      allPeersReady: true,
      hasConflict: false,
    });
    try {
      guard.acquire({
        repository: "atlas",
        holder: "beta",
        baselineDigest: snapshot.manifestDigest,
        now: Date.now(),
        ttlMs: 30_000,
        allPeersReady: true,
        hasConflict: false,
      });
      throw new Error("Guard failed to deny the competing writer");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("repository-busy")
      )
        throw error;
      notes.push("guarded-denial: beta could not acquire alpha's atlas lease");
    }
    const expiryOperation = "guarded-heartbeat-expiry";
    const expiryPath = "guard/must-not-complete.txt";
    journal.append(
      controllerEntry(
        runId,
        "alpha",
        "atlas",
        expiryOperation,
        "write",
        "planned",
        { relativePath: expiryPath },
      ),
    );
    const alpha = findPeer(config, "alpha");
    const alphaPaths = validateRunRoot(alpha.runBase, runId);
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
      expiryOperation,
      "--path",
      expiryPath,
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
        expiryOperation,
        "write",
        "interrupted",
        {
          relativePath: expiryPath,
          detail: "controller-heartbeat-expired",
        },
      ),
    );
    if (existsSync(join(alphaPaths.workspace, "atlas", expiryPath)))
      throw new Error("Heartbeat-expired writer still mutated the workspace");
    notes.push(
      "guarded-denial: heartbeat expiry terminated the alpha probe writer",
    );
    runWrite(
      alpha,
      runId,
      "atlas",
      "guarded-alpha-shared",
      "src/shared.txt",
      journal,
    );
    guard.release(lease);
  } else {
    for (const peerName of peerNames) {
      const peer = findPeer(config, peerName);
      runWrite(
        peer,
        runId,
        "atlas",
        `conflict-${peerName}-shared`,
        "src/shared.txt",
        journal,
      );
      runWrite(
        peer,
        runId,
        "birch",
        `conflict-${peerName}-distinct`,
        `offline/${peerName}.txt`,
        journal,
      );
      runCommit(
        peer,
        runId,
        "coral",
        `conflict-${peerName}-commit`,
        "conflict/shared",
        `commits/${peerName}.txt`,
        journal,
      );
    }
  }
  for (const peerName of ["alpha", "gamma", "beta"] as const) {
    service(findPeer(config, peerName), "start");
    await delay(2_000);
  }
}

async function liveChurn(
  config: HarnessConfig,
  runId: string,
  mode: ScenarioMode,
  journal: DurableJournal,
  notes: string[],
): Promise<void> {
  for (const peer of config.peers) service(peer, "start");
  service(findPeer(config, "gamma"), "stop");
  if (mode === "guarded")
    notes.push("repo-scoped owners: alpha/atlas beta/birch gamma/coral");
  const workloads = peerNames.map(async (peerName, index) => {
    const peer = findPeer(config, peerName);
    const repository = repositoryNames[index];
    if (repository === undefined) throw new Error("Missing churn repository");
    const planned = Array.from({ length: 40 }, (_, operation) => ({
      operationId: `churn-${peerName}-${operation}`,
      action: "write",
      relativePath: `churn/${peerName}/operation-${operation}.txt`,
    }));
    for (const operation of planned)
      journal.append(
        controllerEntry(
          runId,
          peerName,
          repository,
          operation.operationId,
          operation.action,
          "planned",
          { relativePath: operation.relativePath },
        ),
      );
    const commitOperationId = `churn-${peerName}-commit`;
    const backupRef = `refs/treesync-harness/${peerName}/${commitOperationId}`;
    journal.append(
      controllerEntry(
        runId,
        peerName,
        repository,
        commitOperationId,
        "commit",
        "planned",
        {
          refName: `refs/heads/churn/${peerName}`,
          ...(mode === "guarded" ? { backupRef } : {}),
        },
      ),
    );
    const result = await runWorkerJsonAsync(peer, runId, "churn", [
      "--peer",
      peerName,
      "--repository",
      repository,
      "--count",
      "40",
      ...(mode === "guarded" ? ["--guarded"] : []),
    ]);
    const operations = parseOperationArray(result);
    for (const operation of operations) {
      journal.append(
        controllerEntry(
          runId,
          peerName,
          repository,
          operation.operationId,
          operation.type,
          "completed",
          operation,
        ),
      );
    }
  });
  await delay(500);
  service(findPeer(config, "beta"), "stop");
  service(findPeer(config, "beta"), "start");
  await Promise.all(workloads);
  service(findPeer(config, "gamma"), "start");
}

function runWrite(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  operationId: string,
  relativePath: string,
  journal: DurableJournal,
): void {
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
      { relativePath, ...result },
    ),
  );
}

function runCommit(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  operationId: string,
  branch: string,
  relativePath: string,
  journal: DurableJournal,
): void {
  const refName = `refs/heads/${branch}`;
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "commit",
      "planned",
      { relativePath, refName },
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
      { relativePath, refName, ...result },
    ),
  );
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

function bootstrapRunRoot(peer: PeerConfig, runId: string): void {
  const paths = resolveRunPaths(peer.runBase, runId);
  const sentinel = JSON.stringify({
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
  });
  const script =
    'set -eu; base="$1"; run="$2"; sentinel="$3"; root="$base/$run"; test ! -e "$root"; umask 077; mkdir -p "$root/workspace" "$root/control" "$root/tools"; printf "%s\\n" "$sentinel" > "$root/.treesync-safety-run.json"';
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
  runCommand("scp", ["-q", "-r", `${dist}/.`, `${peer.host}:${paths.tools}/`]);
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
  return JSON.parse(result.stdout);
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
  return JSON.parse(result.stdout);
}

function runSnapshot(peer: PeerConfig, runId: string): SnapshotResult {
  return runWorkerJson(peer, runId, "snapshot", []) as SnapshotResult;
}

async function waitForConvergence(
  config: HarnessConfig,
  runId: string,
  peers: readonly PeerName[],
): Promise<void> {
  const deadline = Date.now() + config.convergenceTimeoutMs;
  let matchingSamples = 0;
  let previousDigest = "";
  while (Date.now() < deadline) {
    const snapshots = peers.map((name) => {
      const peer = findPeer(config, name);
      const paths = resolveRunPaths(peer.runBase, runId);
      const status = treesyncStatus(peer, paths.workspace);
      if (!statusIsIdle(status)) return undefined;
      return runSnapshot(peer, runId);
    });
    if (snapshots.every((snapshot) => snapshot !== undefined)) {
      const present = snapshots as SnapshotResult[];
      const digests = new Set(
        present.map((snapshot) => snapshot.manifestDigest),
      );
      const valid = present.every((snapshot) =>
        Object.values(snapshot.repositories).every(
          (repository) => repository.valid,
        ),
      );
      const digest = present[0]?.manifestDigest ?? "";
      if (digests.size === 1 && valid && digest === previousDigest) {
        matchingSamples += 1;
      } else {
        matchingSamples = 1;
        previousDigest = digest;
      }
      if (matchingSamples >= config.quietSamples) return;
    } else {
      matchingSamples = 0;
    }
    await delay(config.quietIntervalMs);
  }
  throw new Error(`Convergence timeout for ${peers.join(",")}`);
}

function statusIsIdle(status: string): boolean {
  if (status.includes("logged in: no")) return false;
  const pending = /pending changes:\s*(\d+)\s+file/i.exec(status);
  if (pending?.[1] !== "0") return false;
  const local = /local snapshot:\s*([a-f0-9]+)/i.exec(status)?.[1];
  const remote = /remote snapshot:\s*([a-f0-9]+)/i.exec(status)?.[1];
  return local !== undefined && remote !== undefined && local === remote;
}

function treesyncStatus(peer: PeerConfig, workspace: string): string {
  const result = runOnPeer(
    peer,
    peer.treesyncBinary,
    ["status", workspace, "--once", "--no-color"],
    true,
  );
  if (result.status !== 0)
    throw new Error(
      `TreeSync status failed on ${peer.name}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

function service(peer: PeerConfig, action: "start" | "stop"): void {
  runOnPeer(peer, peer.treesyncBinary, [action]);
  const status = runOnPeer(
    peer,
    peer.treesyncBinary,
    ["service", "status", "--no-color"],
    true,
  );
  const running = /background service:\s*running/i.test(status.stdout);
  if ((action === "start" && !running) || (action === "stop" && running)) {
    throw new Error(`TreeSync service did not ${action} on ${peer.name}`);
  }
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
    const result = runOnPeer(peer, "/bin/cat", [
      join(paths.control, "peer.jsonl"),
    ]);
    aggregateEntries.push(result.stdout.trimEnd());
  }
  const aggregatePath = join(alphaPaths.control, "peer-aggregate.jsonl");
  durableWrite(
    aggregatePath,
    `${aggregateEntries.filter(Boolean).join("\n")}\n`,
  );
  const verification = {} as Record<PeerName, VerificationResult>;
  for (const peer of config.peers) {
    const paths = validateRemoteRunRoot(peer, runId);
    if (peer.host !== "local") {
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
  return verification;
}

function durableWrite(path: string, content: string): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function treesyncGlobalStatus(peer: PeerConfig): string {
  const result = runOnPeer(
    peer,
    peer.treesyncBinary,
    ["status", "--once", "--no-color"],
    true,
  );
  if (result.status !== 0)
    throw new Error(
      `TreeSync status failed on ${peer.name}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

function folderIsRegistered(peer: PeerConfig, workspace: string): boolean {
  return (
    runOnPeer(
      peer,
      peer.treesyncBinary,
      ["status", workspace, "--once", "--no-color"],
      true,
    ).status === 0
  );
}

function assertNoExistingFolders(peer: PeerConfig, workspace: string): void {
  if (folderIsRegistered(peer, workspace)) return;
  const result = runOnPeer(
    peer,
    peer.treesyncBinary,
    ["service", "status", "--no-color"],
    true,
  );
  const count = /synced folders:\s*(\d+)/i.exec(result.stdout)?.[1];
  if (count !== "0") {
    throw new Error(
      `${peer.name} has existing TreeSync folders or ambiguous service state; refusing to control its global daemon`,
    );
  }
}

function validateRemoteRunRoot(peer: PeerConfig, runId: string) {
  const paths = resolveRunPaths(peer.runBase, runId);
  if (peer.host === "local") return validateRunRoot(peer.runBase, runId);
  const result = runOnPeer(peer, "/bin/cat", [
    join(paths.root, ".treesync-safety-run.json"),
  ]);
  const value: unknown = JSON.parse(result.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("runId" in value) ||
    value.runId !== runId
  )
    throw new Error(`Remote sentinel mismatch on ${peer.name}`);
  return paths;
}

async function linkWithoutCapture(
  alpha: PeerConfig,
  alphaWorkspace: string,
  target: PeerConfig,
  targetWorkspace: string,
): Promise<void> {
  const source = spawn(
    alpha.treesyncBinary,
    ["link", "--name", `treesync-harness-${target.name}`, "--no-color"],
    { cwd: alphaWorkspace, stdio: ["ignore", "pipe", "inherit"] },
  );
  const script =
    'set -eu; binary="$1"; destination="$2"; ticket=""; while IFS= read -r line; do case "$line" in *"treesync join "*) value=${line#*treesync join }; ticket=${value%% *};; esac; done; test -n "$ticket"; exec "$binary" join "$ticket" --path "$destination"';
  const remoteCommand = [
    "/bin/sh",
    "-c",
    script,
    "sh",
    target.treesyncBinary,
    targetWorkspace,
  ]
    .map(shellQuote)
    .join(" ");
  const join = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      target.host,
      remoteCommand,
    ],
    { stdio: [source.stdout, "inherit", "inherit"] },
  );
  const [sourceStatus, joinStatus] = await Promise.all([
    waitForChild(source),
    waitForChild(join),
  ]);
  if (sourceStatus !== 0 || joinStatus !== 0)
    throw new Error(`TreeSync link/join failed for ${target.name}`);
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolveStatus(status ?? 1));
  });
}

function findPeer(config: HarnessConfig, name: PeerName): PeerConfig {
  const peer = config.peers.find((candidate) => candidate.name === name);
  if (peer === undefined) throw new Error(`Missing peer ${name}`);
  return peer;
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
    )
      throw new Error("Invalid churn operation output");
    return item as RemoteOperationResult & {
      readonly operationId: string;
      readonly type: string;
    };
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
