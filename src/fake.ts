import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createFixture } from "./fixture.js";
import { git } from "./git.js";
import { DurableJournal, readJournal } from "./journal.js";
import { digestManifest, buildManifest } from "./manifest.js";
import { createCommit, writeCanary } from "./operations.js";
import { createRunRoot, type RunPaths } from "./paths.js";
import {
  peerNames,
  repositoryNames,
  type PeerName,
  type ScenarioMode,
  type ScenarioName,
  type ScenarioResult,
  type VerificationResult,
} from "./types.js";
import { verifyPeer } from "./verifier.js";
import { LeaseGuard } from "./guard.js";

interface FakeRun {
  readonly controllerPaths: RunPaths;
  readonly peers: Readonly<Record<PeerName, RunPaths>>;
  readonly controllerJournal: DurableJournal;
  readonly peerJournals: Readonly<Record<PeerName, DurableJournal>>;
}

export function runFakeScenario(input: {
  readonly base: string;
  readonly runId: string;
  readonly scenario: ScenarioName;
  readonly mode: ScenarioMode;
  readonly seed: number;
  readonly injectLoss?: boolean;
}): ScenarioResult {
  const startedAt = new Date().toISOString();
  const run = prepareFakeRun(input.base, input.runId, input.seed);
  const notes: string[] = [];
  try {
    switch (input.scenario) {
      case "serial":
        runSerial(run, input.runId);
        notes.push(
          "Services were modeled as paused between each serial handoff.",
        );
        break;
      case "conflict":
        runConflict(run, input.runId, input.mode);
        notes.push(
          "Concurrent file versions converged with deterministic sidecars.",
        );
        break;
      case "churn":
        runChurn(run, input.runId, input.mode);
        notes.push(
          "Three repo owners ran concurrently with one denied contender.",
        );
        break;
    }
    if (input.injectLoss === true) injectCompletedOperationLoss(run);
  } finally {
    run.controllerJournal.close();
    for (const peer of peerNames) run.peerJournals[peer].close();
  }

  const controllerEntries = readJournal(
    join(run.controllerPaths.control, "controller.jsonl"),
  );
  const verification = {} as Record<PeerName, VerificationResult>;
  for (const peer of peerNames) {
    verification[peer] = verifyPeer({
      paths: run.peers[peer],
      controllerEntries,
      peerEntries: peerNames.flatMap((sourcePeer) =>
        readJournal(join(run.peers[sourcePeer].control, "peer.jsonl")),
      ),
    });
  }
  const manifests = new Set(
    peerNames.map((peer) => verification[peer].manifestDigest),
  );
  const passed =
    manifests.size === 1 &&
    peerNames.every((peer) => verification[peer].passed);
  if (manifests.size !== 1) notes.push("Peer manifests did not converge.");
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    mode: input.mode,
    adapter: "fake",
    seed: input.seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: passed ? "pass" : "product-failure",
    verification,
    notes,
  };
}

function prepareFakeRun(base: string, runId: string, seed: number): FakeRun {
  const controllerPaths = createRunRoot(join(base, "controller"), runId);
  const peers = {} as Record<PeerName, RunPaths>;
  for (const peer of peerNames) {
    peers[peer] = createRunRoot(join(base, "peers", peer), runId);
  }
  createFixture(peers.alpha.workspace, seed);
  mirrorWorkspace(peers.alpha.workspace, peers.beta.workspace);
  mirrorWorkspace(peers.alpha.workspace, peers.gamma.workspace);
  return {
    controllerPaths,
    peers,
    controllerJournal: new DurableJournal(
      join(controllerPaths.control, "controller.jsonl"),
    ),
    peerJournals: Object.fromEntries(
      peerNames.map((peer) => [
        peer,
        new DurableJournal(join(peers[peer].control, "peer.jsonl")),
      ]),
    ) as Record<PeerName, DurableJournal>,
  };
}

function context(
  run: FakeRun,
  runId: string,
  peer: PeerName,
  repository: "atlas" | "birch" | "coral",
) {
  return {
    runId,
    peer,
    repository,
    controllerJournal: run.controllerJournal,
    peerJournal: run.peerJournals[peer],
    peerPaths: run.peers[peer],
  };
}

function runSerial(run: FakeRun, runId: string): void {
  for (const peer of peerNames) {
    for (const repository of repositoryNames) {
      writeCanary(context(run, runId, peer, repository), {
        operationId: `serial-${peer}-${repository}-file`,
        relativePath: `handoff/${peer}.txt`,
      });
      createCommit(context(run, runId, peer, repository), {
        operationId: `serial-${peer}-${repository}-commit`,
        branch: `serial/${peer}`,
        relativePath: `commits/${peer}.txt`,
      });
    }
    for (const target of peerNames) {
      if (target !== peer)
        mirrorWorkspace(run.peers[peer].workspace, run.peers[target].workspace);
    }
  }
}

function runConflict(run: FakeRun, runId: string, mode: ScenarioMode): void {
  if (mode === "guarded") exerciseGuard(run);
  const sharedVersions = new Map<PeerName, string>();
  for (const peer of peerNames) {
    writeCanary(context(run, runId, peer, "atlas"), {
      operationId: `conflict-${peer}-shared`,
      relativePath: "src/shared.txt",
      contentPrefix: `replacement from ${peer}`,
    });
    writeCanary(context(run, runId, peer, "birch"), {
      operationId: `conflict-${peer}-distinct`,
      relativePath: `offline/${peer}.txt`,
    });
    sharedVersions.set(
      peer,
      readFileSync(
        join(run.peers[peer].workspace, "atlas", "src", "shared.txt"),
        "utf8",
      ),
    );
    createCommit(context(run, runId, peer, "coral"), {
      operationId: `conflict-${peer}-commit`,
      branch: `conflict/${peer}`,
      relativePath: `commits/${peer}.txt`,
    });
  }

  const canonical = run.peers.gamma.workspace;
  for (const source of ["alpha", "beta"] as const) {
    const sourceRepository = join(run.peers[source].workspace, "coral");
    git(join(canonical, "coral"), [
      "fetch",
      sourceRepository,
      `refs/heads/conflict/${source}:refs/heads/conflict/${source}`,
    ]);
    copyFileWithin(
      run.peers[source].workspace,
      canonical,
      `birch/offline/${source}.txt`,
    );
  }
  for (const source of ["alpha", "beta"] as const) {
    const sidecar = join(
      canonical,
      "atlas",
      "src",
      `shared (conflict from ${source}).txt`,
    );
    writeFileSync(sidecar, sharedVersions.get(source) ?? "");
  }
  for (const peer of ["alpha", "beta"] as const)
    mirrorWorkspace(canonical, run.peers[peer].workspace);
}

function runChurn(run: FakeRun, runId: string, mode: ScenarioMode): void {
  if (mode === "guarded") exerciseGuard(run);
  for (let index = 0; index < peerNames.length; index += 1) {
    const peer = peerNames[index];
    const repository = repositoryNames[index];
    if (peer === undefined || repository === undefined) continue;
    for (let operation = 0; operation < 18; operation += 1) {
      writeCanary(context(run, runId, peer, repository), {
        operationId: `churn-${peer}-${operation}`,
        relativePath: `churn/${peer}/operation-${operation}.txt`,
      });
    }
    createCommit(context(run, runId, peer, repository), {
      operationId: `churn-${peer}-commit`,
      branch: `churn/${peer}`,
      relativePath: `churn/${peer}/committed.txt`,
    });
  }
  for (let index = 0; index < repositoryNames.length; index += 1) {
    const repository = repositoryNames[index];
    const owner = peerNames[index];
    if (repository === undefined || owner === undefined) continue;
    for (const target of peerNames) {
      if (target === owner) continue;
      mirrorRepository(
        join(run.peers[owner].workspace, repository),
        join(run.peers[target].workspace, repository),
      );
    }
  }
}

function exerciseGuard(run: FakeRun): void {
  const guard = new LeaseGuard();
  const baseline = digestManifest(buildManifest(run.peers.alpha.workspace));
  const lease = guard.acquire({
    repository: "atlas",
    holder: "alpha",
    baselineDigest: baseline,
    now: 1_000,
    ttlMs: 500,
    allPeersReady: true,
    hasConflict: false,
  });
  try {
    guard.acquire({
      repository: "atlas",
      holder: "beta",
      baselineDigest: baseline,
      now: 1_100,
      ttlMs: 500,
      allPeersReady: true,
      hasConflict: false,
    });
    throw new Error("Guard allowed a competing writer");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("repository-busy"))
      throw error;
  }
  guard.release(lease);
}

function injectCompletedOperationLoss(run: FakeRun): void {
  for (const peer of peerNames) {
    const path = join(
      run.peers[peer].workspace,
      "atlas",
      "handoff",
      "alpha.txt",
    );
    rmSync(path, { force: true });
  }
}

function mirrorWorkspace(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, preserveTimestamps: false });
}

function mirrorRepository(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, preserveTimestamps: false });
}

function copyFileWithin(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): void {
  const destination = join(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(join(sourceRoot, relativePath)));
}
