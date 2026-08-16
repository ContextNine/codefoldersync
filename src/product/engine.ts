import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSnapshot } from "./codec.js";
import { fsyncDirectory, readJson, writeJsonAtomic } from "./io.js";
import {
  captureSnapshot,
  createSnapshot,
  materializeSnapshot,
  scanUnit,
  validateSnapshot,
} from "./snapshot.js";
import { loadClientState, replaceUnitState, saveClientState } from "./state.js";
import { HubTransport } from "./transport.js";
import {
  type ClientState,
  type ProductConfig,
  type Snapshot,
  type SyncUnitResult,
  type UnitState,
  type UnitStatus,
} from "./types.js";
import { assertUnit } from "./validation.js";

export function syncFolder(config: ProductConfig): readonly SyncUnitResult[] {
  const transport = new HubTransport(config.hub);
  const remoteState = transport.getFolderState(config.folderId);
  assertFolderRecordMatches(config, remoteState.folder);
  let state = loadClientState(config);
  const results: SyncUnitResult[] = [];
  for (const unit of config.units) {
    try {
      const remote = remoteState.units[unit];
      if (remote === undefined)
        throw new Error(`Hub omitted repository: ${unit}`);
      const outcome = syncUnit(config, transport, state, unit, remote);
      state = outcome.state;
      saveClientState(config, state);
      results.push(outcome.result);
    } catch (error) {
      results.push({
        unit,
        action: "inconclusive",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function statusFolder(config: ProductConfig): readonly UnitStatus[] {
  const transport = new HubTransport(config.hub);
  const remoteState = transport.getFolderState(config.folderId);
  assertFolderRecordMatches(config, remoteState.folder);
  const state = loadClientState(config);
  return config.units.map((unit) => {
    try {
      const unitState = state.units[unit] ?? {};
      const remote = remoteState.units[unit];
      if (remote === undefined)
        throw new Error(`Hub omitted repository: ${unit}`);
      const localPath = join(config.root, unit);
      const localDigest = existsSync(localPath)
        ? scanUnit(localPath).treeDigest
        : null;
      if (unitState.blocked !== undefined) {
        return {
          unit,
          status: "blocked",
          baselineId: unitState.baselineId ?? null,
          localDigest,
          remoteHeadId: remote.head,
          reason: "unresolved concurrent repository state",
        };
      }
      const baselineId = unitState.baselineId ?? null;
      if (baselineId === null) {
        return {
          unit,
          status:
            remote.head === null
              ? localDigest === null
                ? "inconclusive"
                : "local-ahead"
              : localDigest === null
                ? "remote-ahead"
                : remote.snapshot?.treeDigest === localDigest
                  ? "remote-ahead"
                  : "blocked",
          baselineId,
          localDigest,
          remoteHeadId: remote.head,
        };
      }
      if (localDigest === null) {
        return {
          unit,
          status: "inconclusive",
          baselineId,
          localDigest,
          remoteHeadId: remote.head,
          reason: "tracked repository is missing locally",
        };
      }
      const localChanged =
        unitState.baselineDigest === undefined ||
        localDigest !== unitState.baselineDigest;
      const remoteChanged = remote.head !== baselineId;
      return {
        unit,
        status:
          localChanged && remoteChanged
            ? "blocked"
            : localChanged
              ? "local-ahead"
              : remoteChanged
                ? "remote-ahead"
                : "clean",
        baselineId,
        localDigest,
        remoteHeadId: remote.head,
      };
    } catch (error) {
      return {
        unit,
        status: "inconclusive",
        baselineId: state.units[unit]?.baselineId ?? null,
        localDigest: null,
        remoteHeadId: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function resolveConflict(
  config: ProductConfig,
  unit: string,
  choice: "local" | "remote",
): SyncUnitResult {
  assertUnit(unit);
  if (!config.units.includes(unit))
    throw new Error(`Unknown repository: ${unit}`);
  const transport = new HubTransport(config.hub);
  assertFolderMatches(config, transport);
  let state = loadClientState(config);
  const unitState = state.units[unit] ?? {};
  if (unitState.blocked === undefined)
    throw new Error(`${unit} is not blocked`);
  const remote = transport.getUnit(config.folderId, unit);
  if (remote.head === null || remote.snapshot === null) {
    throw new Error("Remote repository head is missing");
  }
  const current = captureLocal(config, unit, unitState.baselineId ?? null);
  if (
    current.treeDigest !==
    transport.getSnapshot(config.folderId, unitState.blocked.localSnapshotId)
      .treeDigest
  ) {
    transport.preserveConflict(config.folderId, remote.head, current);
  }
  if (choice === "remote") {
    applySnapshot(config, unit, remote.snapshot, unitState.baselineId ?? null);
    state = replaceUnitState(state, unit, {
      baselineId: remote.snapshot.snapshotId,
      baselineDigest: remote.snapshot.treeDigest,
    });
    saveClientState(config, state);
    return { unit, action: "applied", snapshotId: remote.snapshot.snapshotId };
  }
  const promoted = createSnapshot({
    folderId: config.folderId,
    unit,
    parentId: remote.head,
    peerId: config.peerId,
    files: current.files,
  });
  const committed = transport.commit(config.folderId, remote.head, promoted);
  if (!committed.committed) {
    state = replaceUnitState(state, unit, {
      ...unitState,
      blocked: {
        baselineId: unitState.baselineId ?? null,
        localSnapshotId: promoted.snapshotId,
        remoteSnapshotId: committed.currentHead ?? remote.head,
        detectedAt: new Date().toISOString(),
      },
    });
    saveClientState(config, state);
    return {
      unit,
      action: "blocked",
      reason: "remote head changed during resolution",
    };
  }
  state = replaceUnitState(state, unit, {
    baselineId: promoted.snapshotId,
    baselineDigest: promoted.treeDigest,
  });
  saveClientState(config, state);
  return { unit, action: "published", snapshotId: promoted.snapshotId };
}

export function recoverSnapshot(
  config: ProductConfig,
  snapshotId: string,
  destination: string,
): void {
  let snapshot: Snapshot;
  try {
    snapshot = new HubTransport(config.hub).getSnapshot(
      config.folderId,
      snapshotId,
    );
  } catch (hubError) {
    snapshot = findLocalRecovery(config, snapshotId, hubError);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  materializeSnapshot(snapshot, destination);
}

export function listRecoveries(
  config: ProductConfig,
): readonly Pick<
  Snapshot,
  "snapshotId" | "unit" | "createdAt" | "treeDigest"
>[] {
  const result: Array<
    Pick<Snapshot, "snapshotId" | "unit" | "createdAt" | "treeDigest">
  > = [];
  for (const unit of config.units) {
    const directory = join(config.stateDir, "recovery", unit);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const snapshot = parseSnapshot(readJson(join(directory, name)));
      result.push({
        snapshotId: snapshot.snapshotId,
        unit: snapshot.unit,
        createdAt: snapshot.createdAt,
        treeDigest: snapshot.treeDigest,
      });
    }
  }
  return result.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function history(
  config: ProductConfig,
  unit: string,
): readonly Snapshot[] {
  if (!config.units.includes(unit))
    throw new Error(`Unknown repository: ${unit}`);
  return new HubTransport(config.hub).history(config.folderId, unit);
}

function syncUnit(
  config: ProductConfig,
  transport: HubTransport,
  state: ClientState,
  unit: string,
  remote: { readonly head: string | null; readonly snapshot: Snapshot | null },
): { readonly state: ClientState; readonly result: SyncUnitResult } {
  const unitState = state.units[unit] ?? {};
  if (unitState.blocked !== undefined) {
    return {
      state,
      result: {
        unit,
        action: "blocked",
        reason: "explicit resolution required",
      },
    };
  }
  const localPath = join(config.root, unit);
  const local = existsSync(localPath)
    ? captureLocal(config, unit, unitState.baselineId ?? null)
    : null;
  const baselineId = unitState.baselineId ?? null;

  if (baselineId === null) {
    if (remote.head === null) {
      if (local === null)
        throw new Error(`Repository is absent on client and hub: ${unit}`);
      return publish(
        config,
        transport,
        state,
        unit,
        unitState,
        local,
        null,
        "initialized",
      );
    }
    if (remote.snapshot === null)
      throw new Error("Hub head snapshot is missing");
    if (local === null) {
      applySnapshot(config, unit, remote.snapshot, null);
      return advanced(state, unit, remote.snapshot, "applied");
    }
    if (local.treeDigest === remote.snapshot.treeDigest) {
      return advanced(state, unit, remote.snapshot, "coalesced");
    }
    return block(config, transport, state, unit, unitState, local, remote.head);
  }

  if (local === null)
    throw new Error(`Tracked repository is missing locally: ${unit}`);
  if (unitState.baselineDigest === undefined)
    throw new Error("Baseline digest is missing");
  if (remote.head === null || remote.snapshot === null)
    throw new Error("Hub head is missing");
  const localChanged = local.treeDigest !== unitState.baselineDigest;
  const remoteChanged = remote.head !== baselineId;

  if (!localChanged && !remoteChanged) {
    return { state, result: { unit, action: "clean", snapshotId: baselineId } };
  }
  if (remoteChanged && local.treeDigest === remote.snapshot.treeDigest) {
    return advanced(state, unit, remote.snapshot, "coalesced");
  }
  if (localChanged && !remoteChanged) {
    return publish(
      config,
      transport,
      state,
      unit,
      unitState,
      local,
      baselineId,
      "published",
    );
  }
  if (!localChanged && remoteChanged) {
    applySnapshot(config, unit, remote.snapshot, baselineId);
    return advanced(state, unit, remote.snapshot, "applied");
  }
  return block(config, transport, state, unit, unitState, local, remote.head);
}

function publish(
  config: ProductConfig,
  transport: HubTransport,
  state: ClientState,
  unit: string,
  unitState: UnitState,
  snapshot: Snapshot,
  expectedHead: string | null,
  successAction: "initialized" | "published",
): { readonly state: ClientState; readonly result: SyncUnitResult } {
  const committed = transport.commit(config.folderId, expectedHead, snapshot);
  if (!committed.committed) {
    if (committed.currentHead === null)
      throw new Error("Hub lost repository head during publish");
    return blockedState(
      state,
      unit,
      unitState,
      snapshot.snapshotId,
      committed.currentHead,
    );
  }
  return advanced(state, unit, snapshot, successAction);
}

function block(
  config: ProductConfig,
  transport: HubTransport,
  state: ClientState,
  unit: string,
  unitState: UnitState,
  local: Snapshot,
  remoteHead: string,
): { readonly state: ClientState; readonly result: SyncUnitResult } {
  transport.preserveConflict(config.folderId, remoteHead, local);
  return blockedState(state, unit, unitState, local.snapshotId, remoteHead);
}

function blockedState(
  state: ClientState,
  unit: string,
  unitState: UnitState,
  localSnapshotId: string,
  remoteSnapshotId: string,
): { readonly state: ClientState; readonly result: SyncUnitResult } {
  return {
    state: replaceUnitState(state, unit, {
      ...unitState,
      blocked: {
        baselineId: unitState.baselineId ?? null,
        localSnapshotId,
        remoteSnapshotId,
        detectedAt: new Date().toISOString(),
      },
    }),
    result: {
      unit,
      action: "blocked",
      snapshotId: localSnapshotId,
      reason: "local and remote repository states diverged",
    },
  };
}

function advanced(
  state: ClientState,
  unit: string,
  snapshot: Snapshot,
  action: "applied" | "coalesced" | "initialized" | "published",
): { readonly state: ClientState; readonly result: SyncUnitResult } {
  return {
    state: replaceUnitState(state, unit, {
      baselineId: snapshot.snapshotId,
      baselineDigest: snapshot.treeDigest,
    }),
    result: { unit, action, snapshotId: snapshot.snapshotId },
  };
}

function captureLocal(
  config: ProductConfig,
  unit: string,
  parentId: string | null,
): Snapshot {
  return captureSnapshot({
    folderId: config.folderId,
    unit,
    unitPath: join(config.root, unit),
    parentId,
    peerId: config.peerId,
  });
}

function applySnapshot(
  config: ProductConfig,
  unit: string,
  snapshot: Snapshot,
  baselineId: string | null,
): void {
  validateSnapshot(snapshot);
  if (snapshot.folderId !== config.folderId || snapshot.unit !== unit) {
    throw new Error("Remote snapshot does not match configured repository");
  }
  const current = join(config.root, unit);
  const recoveryDirectory = join(config.stateDir, "recovery", unit);
  const replacedDirectory = join(config.stateDir, "replaced", unit);
  const stagingDirectory = join(config.stateDir, "staging");
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(replacedDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });

  let localRecovery: Snapshot | null = null;
  if (existsSync(current)) {
    localRecovery = captureSnapshot({
      folderId: config.folderId,
      unit,
      unitPath: current,
      parentId: baselineId,
      peerId: config.peerId,
    });
    const recoveryPath = join(
      recoveryDirectory,
      `${localRecovery.snapshotId}.json`,
    );
    if (!existsSync(recoveryPath)) writeJsonAtomic(recoveryPath, localRecovery);
    fsyncDirectory(recoveryDirectory);
  }

  const stage = join(stagingDirectory, `${unit}-${randomUUID()}`);
  materializeSnapshot(snapshot, stage);
  fsyncDirectory(stagingDirectory);
  const displaced = join(
    replacedDirectory,
    `${localRecovery?.snapshotId ?? "empty"}-${randomUUID()}`,
  );
  let movedCurrent = false;
  try {
    if (existsSync(current)) {
      renameSync(current, displaced);
      movedCurrent = true;
      fsyncDirectory(config.root);
    }
    renameSync(stage, current);
    fsyncDirectory(config.root);
    fsyncDirectory(replacedDirectory);
  } catch (error) {
    if (movedCurrent && !existsSync(current) && existsSync(displaced)) {
      renameSync(displaced, current);
      fsyncDirectory(config.root);
    }
    throw error;
  }
}

function assertFolderMatches(
  config: ProductConfig,
  transport: HubTransport,
): void {
  assertFolderRecordMatches(config, transport.getFolder(config.folderId));
}

function assertFolderRecordMatches(
  config: ProductConfig,
  folder: ReturnType<HubTransport["getFolder"]>,
): void {
  if (
    folder.folderName !== config.folderName ||
    JSON.stringify([...folder.units].sort()) !==
      JSON.stringify([...config.units].sort())
  ) {
    throw new Error("Hub folder metadata does not match local configuration");
  }
}

function findLocalRecovery(
  config: ProductConfig,
  snapshotId: string,
  hubError: unknown,
): Snapshot {
  for (const unit of config.units) {
    const path = join(config.stateDir, "recovery", unit, `${snapshotId}.json`);
    if (existsSync(path)) return parseSnapshot(readJson(path));
  }
  throw hubError;
}
