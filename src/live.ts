import { spawn } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  const versions = new Set(
    readiness.map((result) => result.codefoldersyncVersion),
  );
  if (versions.size !== 1)
    throw new Error("All peers must run the same CodeFolderSync version");

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
          codefoldersync: result.codefoldersyncVersion,
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
  const alphaStatus = codefoldersyncGlobalStatus(alpha, runId);
  if (alphaStatus.includes("logged in: no")) {
    throw new Error(
      "Alpha is logged out. Complete `codefoldersync login` interactively, then rerun enroll.",
    );
  }
  assertNoExistingFolders(alpha, runId, alphaPaths.workspace);
  if (!folderIsRegistered(alpha, runId, alphaPaths.workspace)) {
    runCodeFolderSyncOnPeer(alpha, runId, [
      "add",
      alphaPaths.workspace,
      "--name",
      `codefoldersync-${runId}`,
    ]);
  }
  runCodeFolderSyncOnPeer(alpha, runId, [
    "push",
    alphaPaths.workspace,
    "--verbose",
  ]);
  service(alpha, runId, "start");

  for (const peer of config.peers.filter(
    (candidate) => candidate.name !== "alpha",
  )) {
    const paths = validateRemoteRunRoot(peer, runId);
    const status = codefoldersyncGlobalStatus(peer, runId);
    if (!status.includes("logged in: no")) {
      throw new Error(
        `${peer.name} already has CodeFolderSync account state; refusing link/join to preserve existing registrations`,
      );
    }
    assertNoExistingFolders(peer, runId, paths.workspace);
    await linkWithoutCapture(
      alpha,
      alphaPaths.workspace,
      peer,
      paths.workspace,
      runId,
    );
    service(peer, runId, "start");
  }
  await waitForConvergence(config, runId, peerNames);
}

export function detachLive(config: HarnessConfig, runId: string): void {
  for (const peer of config.peers) {
    const paths = validateRemoteRunRoot(peer, runId);
    service(peer, runId, "stop");
    if (folderIsRegistered(peer, runId, paths.workspace))
      runCodeFolderSyncOnPeer(peer, runId, ["remove", paths.workspace]);
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
  for (const peer of input.config.peers) service(peer, input.runId, "stop");
  for (const peer of input.config.peers) service(peer, input.runId, "start");
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
    adapter: "codefoldersync",
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
  for (const peer of config.peers) service(peer, runId, "stop");
  const active: PeerName[] = [];
  for (const peerName of peerNames) {
    const peer = findPeer(config, peerName);
    service(peer, runId, "start");
    if (active.length > 0)
      await waitForConvergence(config, runId, [...active, peerName]);
    for (const [repositoryIndex, repository] of repositoryNames.entries()) {
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
      runMetadata(
        peer,
        runId,
        repository,
        "chmod-executable",
        `bin/run-${peerName}.sh`,
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
      if (repositoryIndex === 0) {
        service(peer, runId, "stop");
        service(peer, runId, "start");
      }
    }
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
  for (const peer of config.peers) service(peer, runId, "stop");
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
      runWrite(
        peer,
        runId,
        "coral",
        `conflict-${peerName}-unstaged`,
        "working.txt",
        journal,
      );
      runWrite(
        peer,
        runId,
        "coral",
        `conflict-${peerName}-staged`,
        "staged.txt",
        journal,
      );
      runStage(
        peer,
        runId,
        "coral",
        `conflict-${peerName}-index`,
        "staged.txt",
        journal,
      );
      runWrite(
        peer,
        runId,
        "coral",
        `conflict-${peerName}-untracked`,
        `state/${peerName}-untracked.txt`,
        journal,
      );
    }
    runWrite(
      findPeer(config, "alpha"),
      runId,
      "birch",
      "conflict-alpha-modify-delete",
      "docs/modify-delete.md",
      journal,
    );
    runDelete(
      findPeer(config, "beta"),
      runId,
      "birch",
      "conflict-beta-delete-modified",
      "docs/modify-delete.md",
      journal,
    );
    runDelete(
      findPeer(config, "beta"),
      runId,
      "birch",
      "conflict-beta-delete-collision-file",
      "docs/collision",
      journal,
    );
    runWrite(
      findPeer(config, "beta"),
      runId,
      "birch",
      "conflict-beta-directory-child",
      "docs/collision/beta-child.txt",
      journal,
    );
    runWrite(
      findPeer(config, "gamma"),
      runId,
      "birch",
      "conflict-gamma-collision-file",
      "docs/collision",
      journal,
    );
  }
  for (const peerName of ["alpha", "gamma", "beta"] as const) {
    service(findPeer(config, peerName), runId, "start");
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
  for (const peer of config.peers) service(peer, runId, "start");
  service(findPeer(config, "gamma"), runId, "stop");
  if (mode === "guarded")
    notes.push("repo-scoped owners: alpha/atlas beta/birch gamma/coral");
  const workloads = peerNames.map(async (peerName, index) => {
    const peer = findPeer(config, peerName);
    const repository = repositoryNames[index];
    if (repository === undefined) throw new Error("Missing churn repository");
    const operationKinds = [
      "create",
      "rename",
      "chmod",
      "stage",
      "unstage",
      "append",
      "replace",
    ] as const;
    const planned = Array.from({ length: 40 }, (_, operation) => {
      const kind = operationKinds[operation % operationKinds.length];
      if (kind === undefined) throw new Error("Invalid churn operation kind");
      return {
        operationId: `churn-${peerName}-${operation}`,
        action:
          kind === "rename" || kind === "append" || kind === "replace"
            ? kind
            : "write",
        relativePath:
          kind === "rename"
            ? `churn/${peerName}/renamed-${operation}.txt`
            : `churn/${peerName}/operation-${operation}.txt`,
      };
    });
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
    const deleteOperationId = `churn-${peerName}-delete`;
    const deleteRelativePath = "src/nested/file-7.txt";
    journal.append(
      controllerEntry(
        runId,
        peerName,
        repository,
        deleteOperationId,
        "delete",
        "planned",
        { relativePath: deleteRelativePath },
      ),
    );
    const commitOperationId = `churn-${peerName}-commit`;
    const backupRef = `refs/codefoldersync/${peerName}/${commitOperationId}`;
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
  service(findPeer(config, "beta"), runId, "stop");
  service(findPeer(config, "beta"), runId, "start");
  await Promise.all(workloads);
  service(findPeer(config, "gamma"), runId, "start");
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

function runDelete(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  operationId: string,
  relativePath: string,
  journal: DurableJournal,
): void {
  const evidence = { relativePath, detail: "delete-intent" };
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "delete",
      "planned",
      evidence,
    ),
  );
  runWorkerJson(peer, runId, "delete", [
    "--peer",
    peer.name,
    "--repository",
    repository,
    "--operation",
    operationId,
    "--path",
    relativePath,
  ]);
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "delete",
      "completed",
      evidence,
    ),
  );
}

function runMetadata(
  peer: PeerConfig,
  runId: string,
  repository: RepositoryName,
  command: "chmod-executable",
  relativePath: string,
): void {
  runWorkerJson(peer, runId, command, [
    "--peer",
    peer.name,
    "--repository",
    repository,
    "--path",
    relativePath,
  ]);
}

function runStage(
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
      "stage",
      "planned",
      { relativePath },
    ),
  );
  const result = runWorkerJson(peer, runId, "stage", [
    "--peer",
    peer.name,
    "--repository",
    repository,
    "--operation",
    operationId,
    "--path",
    relativePath,
  ]) as { readonly indexTree: string };
  journal.append(
    controllerEntry(
      runId,
      peer.name,
      repository,
      operationId,
      "stage",
      "completed",
      { relativePath, indexTree: result.indexTree },
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
    'set -eu; base="$1"; run="$2"; sentinel="$3"; root="$base/$run"; test ! -e "$root"; umask 077; mkdir -p "$root/workspace" "$root/control/codefoldersync-home" "$root/tools"; printf "%s\\n" "$sentinel" > "$root/.codefoldersync-run.json"';
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
      const status = codefoldersyncStatus(peer, runId, paths.workspace);
      if (!statusIsIdle(status)) return undefined;
      return runSnapshot(peer, runId);
    });
    if (snapshots.every((snapshot) => snapshot !== undefined)) {
      const present = snapshots as SnapshotResult[];
      const digests = new Set(
        present.map((snapshot) => snapshot.manifestDigest),
      );
      const semanticDigests = new Set(
        present.map((snapshot) => snapshot.gitSemanticDigest),
      );
      const valid = present.every((snapshot) =>
        Object.values(snapshot.repositories).every(
          (repository) => repository.valid,
        ),
      );
      const combinedDigest = `${present[0]?.manifestDigest ?? ""}:${present[0]?.gitSemanticDigest ?? ""}`;
      if (
        digests.size === 1 &&
        semanticDigests.size === 1 &&
        valid &&
        combinedDigest === previousDigest
      ) {
        matchingSamples += 1;
      } else {
        matchingSamples = 1;
        previousDigest = combinedDigest;
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

function codefoldersyncStatus(
  peer: PeerConfig,
  runId: string,
  workspace: string,
): string {
  const result = runCodeFolderSyncOnPeer(
    peer,
    runId,
    ["status", workspace, "--once", "--no-color"],
    true,
  );
  if (result.status !== 0)
    throw new Error(
      `CodeFolderSync status failed on ${peer.name}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

function service(
  peer: PeerConfig,
  runId: string,
  action: "start" | "stop",
): void {
  const result = runWorkerJson(peer, runId, "codefoldersync-service", [
    "--action",
    action,
    "--binary",
    peer.codefoldersyncBinary,
    "--home",
    codefoldersyncHome(peer, runId),
  ]) as { readonly running: boolean };
  if (
    (action === "start" && !result.running) ||
    (action === "stop" && result.running)
  ) {
    throw new Error(`CodeFolderSync service did not ${action} on ${peer.name}`);
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

function durableWrite(path: string, content: string): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function codefoldersyncGlobalStatus(peer: PeerConfig, runId: string): string {
  const result = runCodeFolderSyncOnPeer(
    peer,
    runId,
    ["status", "--once", "--no-color"],
    true,
  );
  if (result.status !== 0)
    throw new Error(
      `CodeFolderSync status failed on ${peer.name}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

function folderIsRegistered(
  peer: PeerConfig,
  runId: string,
  workspace: string,
): boolean {
  return (
    runCodeFolderSyncOnPeer(
      peer,
      runId,
      ["status", workspace, "--once", "--no-color"],
      true,
    ).status === 0
  );
}

function assertNoExistingFolders(
  peer: PeerConfig,
  runId: string,
  workspace: string,
): void {
  if (folderIsRegistered(peer, runId, workspace)) return;
  const result = runCodeFolderSyncOnPeer(
    peer,
    runId,
    ["status", "--once", "--no-color"],
    true,
  );
  if (result.stdout.includes("logged in: no")) return;
  const count = /synced folders:\s*(\d+)/i.exec(result.stdout)?.[1];
  if (count !== "0") {
    throw new Error(
      `${peer.name} has existing CodeFolderSync folders or ambiguous service state; refusing to control its global daemon`,
    );
  }
}

function codefoldersyncHome(peer: PeerConfig, runId: string): string {
  if (peer.codefoldersyncHome !== "run") return peer.codefoldersyncHome;
  return join(
    resolveRunPaths(peer.runBase, runId).control,
    "codefoldersync-home",
  );
}

function runCodeFolderSyncOnPeer(
  peer: PeerConfig,
  runId: string,
  args: readonly string[],
  allowFailure = false,
) {
  return runOnPeer(
    peer,
    "/usr/bin/env",
    [
      `HOME=${codefoldersyncHome(peer, runId)}`,
      peer.codefoldersyncBinary,
      ...args,
    ],
    allowFailure,
  );
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
  )
    throw new Error(`Remote sentinel mismatch on ${peer.name}`);
  return paths;
}

async function linkWithoutCapture(
  alpha: PeerConfig,
  alphaWorkspace: string,
  target: PeerConfig,
  targetWorkspace: string,
  runId: string,
): Promise<void> {
  const source = spawn(
    alpha.codefoldersyncBinary,
    ["link", "--name", `codefoldersync-${target.name}`, "--no-color"],
    {
      cwd: alphaWorkspace,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, HOME: codefoldersyncHome(alpha, runId) },
    },
  );
  const script =
    'set -eu; binary="$1"; destination="$2"; home="$3"; export HOME="$home"; mkdir -p "$HOME"; ticket=""; while IFS= read -r line; do case "$line" in *" join "*) value=${line#* join }; ticket=${value%% *};; esac; done; test -n "$ticket"; exec "$binary" join "$ticket" --path "$destination" --no-daemon';
  const command = [
    "/bin/sh",
    "-c",
    script,
    "sh",
    target.codefoldersyncBinary,
    targetWorkspace,
    codefoldersyncHome(target, runId),
  ];
  const join =
    target.host === "local"
      ? spawn(command[0] ?? "/bin/sh", command.slice(1), {
          stdio: [source.stdout, "inherit", "inherit"],
        })
      : spawn(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            target.host,
            command.map(shellQuote).join(" "),
          ],
          { stdio: [source.stdout, "inherit", "inherit"] },
        );
  const [sourceStatus, joinStatus] = await Promise.all([
    waitForChild(source),
    waitForChild(join),
  ]);
  if (sourceStatus !== 0 || joinStatus !== 0)
    throw new Error(`CodeFolderSync link/join failed for ${target.name}`);
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
