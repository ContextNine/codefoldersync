import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { openDatabase } from "../database.js";
import { canonicalJson, hashBytes, hashText } from "../v2/hash.js";
import { loadConfig } from "./config.js";
import type {
  DistributedFleetSpec,
  DistributedMachineSpec,
} from "./distributed.js";
import {
  acceptanceCrashMarker,
  DistributedAgentTermination,
  type AcceptanceCrashPoint,
  type ProcessDistributedExecutor,
  type NativeFilesystemFault,
  type NativeFilesystemFaultLibrary,
} from "./distributed-process.js";
import { HubStore } from "./hub.js";
import { ObjectStore } from "./objects.js";
import { validateCleanupRunRoot, type CleanupRunSpec } from "./storage.js";
import type { SyncSummary } from "./types.js";

export interface AcceptanceFaultResult {
  readonly processCrashes: readonly AcceptanceCrashPoint[];
  readonly unknownAcknowledgementRetried: true;
  readonly directoryMoveUploadedObjects: 0;
  readonly concurrentConflictPreservedAndRecovered: true;
  readonly hubOutageRejectedAndResumed: true;
  readonly corruptionRejectedBySyncAndVerifier: true;
  readonly repairedCorruptionConverged: true;
  readonly nativeFilesystemFaults: readonly NativeFilesystemFault[];
  readonly scenarioDigest: string;
}

/** Every scenario keeps the complete adopted corpus, mutating only fresh probes. */
export async function runAcceptanceFaults(input: {
  readonly fleet: DistributedFleetSpec;
  readonly executor: ProcessDistributedExecutor;
  readonly run: CleanupRunSpec;
  readonly seed: string;
  readonly nativeFaultLibrary?: NativeFilesystemFaultLibrary;
}): Promise<AcceptanceFaultResult> {
  const { fleet, executor, run, seed } = input;
  const root = validateCleanupRunRoot(run);
  proof(realpathSync(root) === root, "Fault run must be physical");
  proof(fleet.hub.kind === "local", "Fault scenarios require a run-local hub");
  const hubPath = resolve(fleet.hub.path);
  const all = [fleet.authority, ...fleet.targets];
  for (const path of [
    hubPath,
    ...all.flatMap((peer) => [peer.root, peer.stateDir]),
  ])
    proof(
      resolve(path).startsWith(`${root}${sep}`) &&
        realpathSync(path) === resolve(path),
      "Fault paths must remain inside the physical run",
    );
  const target = fleet.targets[0];
  proof(target !== undefined, "Fault scenarios need a populated target");
  const source = fleet.authority;
  const folderId = loadConfig(source.configPath).folderId;
  const workspace = "codefoldersync-acceptance-workload";
  const movedWorkspace = "codefoldersync-acceptance-workload-moved";
  const cassette: { readonly operation: string; readonly digest: string }[] =
    [];
  const content = (label: string): Buffer =>
    Buffer.from(`${label}:${hashText(`${seed}:${label}`)}\n`);
  const create = (
    peer: DistributedMachineSpec,
    local: string,
    bytes: Buffer,
  ): void => {
    writeFileSync(join(peer.root, local), bytes, { mode: 0o600, flag: "wx" });
    cassette.push({ operation: `create:${local}`, digest: hashBytes(bytes) });
  };
  const sync = async (peer: DistributedMachineSpec): Promise<SyncSummary> => {
    const result = await executor.sync(peer, loadConfig(peer.configPath));
    proof(
      result.status === "clean" || result.status === "conflict",
      "Fault recovery sync did not converge",
    );
    return result;
  };
  const converge = async (): Promise<void> => {
    for (const peer of all) await sync(peer);
    await sync(source);
  };

  const queuedPath = `${workspace}/queued-crash.txt`;
  const queuedBytes = content("queued-crash");
  create(source, queuedPath, queuedBytes);
  await crash(source, "after-outbox", executor, run);
  proof(
    outboxCount(source.stateDir) > 0,
    "Process crash did not retain its durable outbox",
  );
  await converge();
  for (const peer of all) proveLeaf(peer, queuedPath, queuedBytes);
  proof(
    outboxCount(source.stateDir) === 0,
    "Restart did not acknowledge the queued event",
  );

  const acceptedPath = `${workspace}/accepted-crash.txt`;
  const acceptedBytes = content("accepted-crash");
  create(source, acceptedPath, acceptedBytes);
  await crash(source, "after-hub-accept", executor, run);
  proof(
    outboxCount(source.stateDir) > 0,
    "Unknown acknowledgement did not retain its exact proposal",
  );
  const acceptedSequence = hubSequence(hubPath, folderId);
  await sync(source);
  proof(
    hubSequence(hubPath, folderId) === acceptedSequence,
    "Retry duplicated the already accepted event",
  );
  proof(
    outboxCount(source.stateDir) === 0,
    "Accepted retry did not drain its outbox",
  );
  await converge();
  for (const peer of all) proveLeaf(peer, acceptedPath, acceptedBytes);

  proof(
    !existsSync(join(source.root, movedWorkspace)),
    "Move probe destination already exists",
  );
  renameSync(join(source.root, workspace), join(source.root, movedWorkspace));
  cassette.push({
    operation: `move:${workspace}:${movedWorkspace}`,
    digest: hashText("complete-subtree"),
  });
  const move = await sync(source);
  proof(
    move.published && move.uploadedObjects === 0,
    "Directory move uploaded content or did not publish",
  );
  await crash(target, "after-moves-staged", executor, run);
  proof(
    pendingApplyCount(target.stateDir) > 0,
    "Killed apply did not retain its durable journal",
  );
  await converge();
  for (const peer of all) {
    proveLeaf(peer, `${movedWorkspace}/queued-crash.txt`, queuedBytes);
    proveLeaf(peer, `${movedWorkspace}/accepted-crash.txt`, acceptedBytes);
    proof(
      !existsSync(join(peer.root, workspace)),
      "Restart did not complete the subtree move",
    );
  }
  proof(
    pendingApplyCount(target.stateDir) === 0,
    "Restart left an incomplete apply journal",
  );

  const conflictPath = `${movedWorkspace}/module-0/file-0.ts`;
  const canonicalBytes = content("canonical-concurrent-write");
  const concurrentBytes = content("losing-concurrent-write");
  writeFileSync(join(source.root, conflictPath), canonicalBytes, {
    mode: 0o600,
  });
  writeFileSync(join(target.root, conflictPath), concurrentBytes, {
    mode: 0o600,
  });
  cassette.push({
    operation: "concurrent-write:canonical",
    digest: hashBytes(canonicalBytes),
  });
  cassette.push({
    operation: "concurrent-write:losing",
    digest: hashBytes(concurrentBytes),
  });
  await sync(source);
  const concurrent = await sync(target);
  proof(
    concurrent.conflicts > 0,
    "Concurrent writes did not produce retained conflict evidence",
  );
  await converge();
  for (const peer of all) {
    proveLeaf(peer, conflictPath, canonicalBytes);
    const parent = join(peer.root, movedWorkspace, "module-0");
    const siblings = readdirSync(parent).filter((name) =>
      name.startsWith("file-0.CODEFOLDERSYNC-CONFLICT."),
    );
    proof(
      siblings.some(
        (name) =>
          hashBytes(readFileSync(join(parent, name))) ===
          hashBytes(concurrentBytes),
      ),
      "Concurrent bytes were not preserved in a visible sibling",
    );
  }
  const conflict = normalConflict(
    hubPath,
    folderId,
    conflictPath,
    loadConfig(target.configPath).peerId,
  );
  proof(
    conflict !== undefined && conflict.manifestId !== null,
    "Concurrent conflict lacks recoverable immutable evidence",
  );
  const recovered = join(target.stateDir, "acceptance-recovered-conflict.txt");
  await executor.recoverAcceptanceConflict(
    target,
    loadConfig(target.configPath),
    run,
    conflict.conflictId,
    recovered,
  );
  proof(
    hashBytes(readFileSync(recovered)) === hashBytes(concurrentBytes),
    "Private conflict recovery did not retain exact bytes",
  );

  const offlinePath = `${movedWorkspace}/offline-edit.txt`;
  const offlineBytes = content("offline-edit");
  const heldHub = `${hubPath}-offline`;
  proof(!existsSync(heldHub), "Offline hub holding path already exists");
  renameSync(hubPath, heldHub);
  const outageMarker = Buffer.from("run-owned-offline-hub\n");
  try {
    writeFileSync(hubPath, outageMarker, { mode: 0o600, flag: "wx" });
    create(source, offlinePath, offlineBytes);
    const unavailable = await executor.sync(
      source,
      loadConfig(source.configPath),
    );
    proof(
      unavailable.status === "inconclusive" || unavailable.status === "offline",
      "Unavailable hub was reported as converged",
    );
    proveLeaf(source, offlinePath, offlineBytes);
    const verification = await executor.verify(
      source,
      loadConfig(source.configPath),
    );
    proof(
      verification.status === "offline" ||
        verification.status === "inconclusive",
      "Verifier accepted an unavailable hub",
    );
  } finally {
    if (existsSync(hubPath)) {
      const marker = lstatSync(hubPath);
      proof(
        marker.isFile() &&
          !marker.isSymbolicLink() &&
          marker.nlink === 1 &&
          hashBytes(readFileSync(hubPath)) === hashBytes(outageMarker),
        "Offline marker changed; preserve held hub for review",
      );
      unlinkSync(hubPath);
    }
    renameSync(heldHub, hubPath);
  }
  await converge();
  for (const peer of all) proveLeaf(peer, offlinePath, offlineBytes);

  const corruptionPath = `${movedWorkspace}/corruption-canary.txt`;
  const corruptionBytes = content("corruption-canary");
  create(source, corruptionPath, corruptionBytes);
  await sync(source);
  const objectId = hashBytes(corruptionBytes);
  {
    using original = new ObjectStore(join(hubPath, "objects"));
    proof(
      hashBytes(original.get(objectId)) === objectId,
      "Fresh canary object is unavailable",
    );
    using targetObjects = new ObjectStore(join(target.stateDir, "objects"));
    proof(
      !targetObjects.has(objectId),
      "Corruption target already has the fresh canary object",
    );
  }
  replaceProbeObject(
    hubPath,
    objectId,
    Buffer.from("deliberately-corrupt-probe\n"),
  );
  try {
    const rejected = await executor.sync(target, loadConfig(target.configPath));
    proof(
      rejected.status === "inconclusive",
      "Corrupt object did not stop target apply",
    );
    proof(
      !existsSync(join(target.root, corruptionPath)),
      "Corrupt object materialized a canary",
    );
    const verified = await executor.verify(
      target,
      loadConfig(target.configPath),
    );
    proof(
      verified.status === "inconclusive",
      "Verifier accepted the lost canary",
    );
  } finally {
    replaceProbeObject(hubPath, objectId, corruptionBytes);
  }
  await converge();
  for (const peer of all) proveLeaf(peer, corruptionPath, corruptionBytes);
  const nativeFilesystemFaults: NativeFilesystemFault[] = [];
  if (input.nativeFaultLibrary !== undefined) {
    for (const fault of ["enospc-write", "eio-fsync"] as const) {
      const local = `${movedWorkspace}/native-${fault}.txt`;
      const prior = content(`${fault}-prior`);
      const desired = content(`${fault}-desired`);
      create(source, local, prior);
      await converge();
      writeFileSync(join(source.root, local), desired, { mode: 0o600 });
      cassette.push({
        operation: `replace:${local}`,
        digest: hashBytes(desired),
      });
      await sync(source);
      const failed = await executor.nativeFaultSync(
        target,
        loadConfig(target.configPath),
        run,
        input.nativeFaultLibrary,
        fault,
      );
      proof(
        failed.status === "inconclusive",
        "Native filesystem failure did not stop apply",
      );
      proof(
        failed.reasons.some((reason) =>
          reason.includes(fault === "enospc-write" ? "ENOSPC" : "EIO"),
        ),
        "Native failure did not report its injected syscall error",
      );
      const recoveredPrior = recoveryProbe(target.stateDir, local);
      proof(
        hashBytes(readFileSync(recoveredPrior)) === hashBytes(prior),
        "Native filesystem failure did not retain prior bytes",
      );
      await converge();
      for (const peer of all) proveLeaf(peer, local, desired);
      proof(
        hashBytes(readFileSync(recoveredPrior)) === hashBytes(prior),
        "Clean native retry removed prior recovery evidence",
      );
      nativeFilesystemFaults.push(fault);
    }
  }
  return {
    processCrashes: ["after-outbox", "after-hub-accept", "after-moves-staged"],
    unknownAcknowledgementRetried: true,
    directoryMoveUploadedObjects: 0,
    concurrentConflictPreservedAndRecovered: true,
    hubOutageRejectedAndResumed: true,
    corruptionRejectedBySyncAndVerifier: true,
    repairedCorruptionConverged: true,
    nativeFilesystemFaults,
    scenarioDigest: hashText(canonicalJson(cassette)),
  };
}

async function crash(
  peer: DistributedMachineSpec,
  point: AcceptanceCrashPoint,
  executor: ProcessDistributedExecutor,
  run: CleanupRunSpec,
): Promise<void> {
  let killed = false;
  try {
    await executor.crashSync(peer, loadConfig(peer.configPath), run, point);
  } catch (error) {
    if (
      !(error instanceof DistributedAgentTermination) ||
      error.signal !== "SIGKILL"
    )
      throw error;
    killed = true;
  }
  proof(killed, "Acceptance product process did not reach its crash boundary");
  const marker: unknown = JSON.parse(
    readFileSync(acceptanceCrashMarker(peer.stateDir, point), "utf8"),
  );
  proof(
    typeof marker === "object" &&
      marker !== null &&
      "point" in marker &&
      marker.point === point,
    "Crash marker does not match the durable boundary",
  );
}

function proveLeaf(
  peer: DistributedMachineSpec,
  local: string,
  bytes: Buffer,
): void {
  proof(
    hashBytes(readFileSync(join(peer.root, local))) === hashBytes(bytes),
    "Fault scenario lost or changed its probe bytes",
  );
}

function outboxCount(stateDir: string): number {
  using database = openDatabase(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });
  const row = database.prepare("SELECT COUNT(*) AS count FROM outbox").get();
  proof(typeof row?.count === "number", "Outbox count is unavailable");
  return row.count;
}

function pendingApplyCount(stateDir: string): number {
  using database = openDatabase(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM journals WHERE kind='snapshot-apply'",
    )
    .get();
  proof(typeof row?.count === "number", "Apply journal count is unavailable");
  return row.count;
}

function recoveryProbe(stateDir: string, local: string): string {
  using database = openDatabase(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });
  const row = database
    .prepare("SELECT json FROM journals WHERE kind='snapshot-apply'")
    .get();
  proof(typeof row?.json === "string", "Native failure lacks an apply journal");
  const journal: unknown = JSON.parse(row.json);
  proof(
    typeof journal === "object" &&
      journal !== null &&
      "recoveryRoot" in journal &&
      typeof journal.recoveryRoot === "string",
    "Native failure lacks a recovery root",
  );
  proof(
    journal.recoveryRoot.startsWith(`${resolve(stateDir)}${sep}`) &&
      realpathSync(journal.recoveryRoot) === journal.recoveryRoot,
    "Native recovery must remain in physical private state",
  );
  return join(journal.recoveryRoot, local);
}

function hubSequence(path: string, folderId: string): number {
  using hub = new HubStore(path);
  return hub.checkpoint(folderId).sequence;
}

function normalConflict(
  path: string,
  folderId: string,
  originalPath: string,
  peerId: string,
) {
  using hub = new HubStore(path);
  return hub
    .conflicts(folderId)
    .find(
      (value) =>
        value.kind === "normal" &&
        value.originalPath === originalPath &&
        value.peerId === peerId,
    );
}

function replaceProbeObject(path: string, id: string, bytes: Buffer): void {
  using database = openDatabase(join(path, "objects", "objects.sqlite"));
  const changed = database
    .prepare("UPDATE objects SET bytes=? WHERE id=?")
    .run(bytes, id);
  proof(
    changed.changes === 1,
    "Probe corruption must affect exactly its one new object",
  );
}

function proof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
