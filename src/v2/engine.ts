import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureLocalLayout, readIgnorePatterns } from "./config.js";
import { hashJson } from "./hash.js";
import {
  capturePath,
  captureTree,
  materializeManifest,
  ObjectStore,
  referencedObjects,
  type CaptureResult,
} from "./objects.js";
import {
  assertInside,
  normalizeRelativePath,
  normalizedEntryKey,
  safeTarget,
  verifyNoSymlinkEscape,
} from "./paths.js";
import { LocalState } from "./state.js";
import {
  HubTransport,
  type PublishExchange,
  type TransferStats,
} from "./transport.js";
import {
  schemaVersion,
  type ChangeBatch,
  type Checkpoint,
  type ConflictRecord,
  type EntryRecord,
  type EventRequest,
  type EventResult,
  type GitStateRecord,
  type LocalEntry,
  type Mutation,
  type NodeKind,
  type NodeRecord,
  type ProductConfig,
  type RepositoryConfig,
  type SyncSummary,
} from "./types.js";

interface EventDraft {
  readonly mutation: Mutation;
  readonly objectIds: readonly string[];
}

type OwnPublished = ScannedEntry | "git";

interface ScannedEntry {
  readonly repository: string;
  readonly path: string;
  readonly parentNodeId: string;
  readonly name: string;
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly manifestId: string | null;
  readonly objectIds: readonly string[];
  readonly device: number;
  readonly inode: number;
  readonly observedSize: number;
  readonly observedMtimeMs: number;
  readonly observedCtimeMs: number;
  readonly observedMode: number;
  readonly baseline: LocalEntry | null;
}

interface Counters {
  scanned: number;
  published: number;
  applied: number;
  uploadedObjects: number;
  uploadedBytes: number;
  downloadedObjects: number;
  downloadedBytes: number;
}

const maximumEventBatch = 4_096;

export async function syncFolderV2(
  config: ProductConfig,
): Promise<SyncSummary> {
  ensureLocalLayout(config);
  verifyNoSymlinkEscape(config.root);
  try {
    await using session = await V2SyncSession.connect(config);
    return await session.sync();
  } catch (error) {
    using state = new LocalState(config);
    return summary(config, emptyCounters(), state.cursor(), "offline", [
      message(error),
    ]);
  }
}

export async function verifyFullV2(
  config: ProductConfig,
): Promise<SyncSummary> {
  ensureLocalLayout(config);
  verifyNoSymlinkEscape(config.root);
  try {
    await using session = await V2SyncSession.connect(config);
    return await session.sync(undefined, true);
  } catch (error) {
    using state = new LocalState(config);
    return summary(config, emptyCounters(), state.cursor(), "offline", [
      message(error),
    ]);
  }
}

export class V2SyncSession implements AsyncDisposable {
  private constructor(
    private readonly config: ProductConfig,
    private readonly state: LocalState,
    private readonly objects: ObjectStore,
    private readonly transport: HubTransport,
  ) {}

  public static async connect(config: ProductConfig): Promise<V2SyncSession> {
    ensureLocalLayout(config);
    verifyNoSymlinkEscape(config.root);
    const state = new LocalState(config);
    try {
      recoverInterruptedApplies(config, state);
      const transport = await HubTransport.connect(config.hub);
      return new V2SyncSession(
        config,
        state,
        new ObjectStore(join(config.stateDir, "objects")),
        transport,
      );
    } catch (error) {
      state[Symbol.dispose]();
      throw error;
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.transport[Symbol.asyncDispose]();
    this.objects[Symbol.dispose]();
    this.state[Symbol.dispose]();
  }

  public async sync(
    dirtyPaths?: readonly string[],
    forceHash = false,
  ): Promise<SyncSummary> {
    const counters = emptyCounters();
    const reasons: string[] = [];
    try {
      return await syncConnected(
        this.config,
        this.state,
        this.objects,
        this.transport,
        counters,
        reasons,
        dirtyPaths,
        forceHash,
      );
    } catch (error) {
      reasons.push(message(error));
      return summary(
        this.config,
        counters,
        this.state.cursor(),
        "inconclusive",
        reasons,
      );
    }
  }

  public async hasRemoteChanges(): Promise<boolean> {
    return (
      (await this.transport.sequence(this.config.folderId)) >
      this.state.cursor()
    );
  }

  public async pullRemote(): Promise<SyncSummary> {
    const counters = emptyCounters();
    const reasons: string[] = [];
    try {
      const applied = await applyRemoteChanges(
        this.config,
        this.state,
        this.objects,
        this.transport,
        counters,
      );
      if (!applied) return this.sync();
      const conflicts = await this.transport.conflicts(this.config.folderId);
      this.state.storeConflicts(conflicts);
      const active = activeLocalConflicts(this.state, conflicts);
      return summary(
        this.config,
        counters,
        this.state.cursor(),
        active > 0 ? "conflict" : "clean",
        reasons,
        active,
      );
    } catch (error) {
      reasons.push(message(error));
      return summary(
        this.config,
        counters,
        this.state.cursor(),
        "inconclusive",
        reasons,
      );
    }
  }
}

async function syncConnected(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  connected: HubTransport,
  counters: Counters,
  reasons: string[],
  dirtyPaths?: readonly string[],
  forceHash = false,
): Promise<SyncSummary> {
  if (
    dirtyPaths !== undefined &&
    state.entryCount() > 0 &&
    state.outboxCount() === 0 &&
    !state.initialJoinPending()
  ) {
    return syncIncrementalConnected(
      config,
      state,
      objects,
      connected,
      counters,
      reasons,
      dirtyPaths,
    );
  }
  const initialCheckpoint = await connected.checkpoint(config.folderId);
  assertCheckpointMatches(config, initialCheckpoint);
  assertSafeInitialState(config, state, initialCheckpoint);

  if (state.initialJoinPending()) {
    const needsReconcile = await recoverInitialJoinState(
      config,
      state,
      objects,
      connected,
      counters,
      initialCheckpoint,
    );
    if (!needsReconcile) {
      const conflicts = await connected.conflicts(config.folderId);
      state.storeConflicts(conflicts);
      const active = activeLocalConflicts(state, conflicts);
      return summary(
        config,
        counters,
        state.cursor(),
        active > 0 ? "conflict" : "clean",
        reasons,
        active,
      );
    }
  }

  await flushOutbox(state, objects, connected, counters);
  if (state.entryCount() === 0 && state.hasPublicationHistory()) {
    await recoverInitialPublicationState(
      config,
      state,
      objects,
      connected,
      counters,
    );
  }
  const drafts: EventDraft[] = [];
  const scans = new Map<string, readonly ScannedEntry[]>();
  const ignore = readIgnorePatterns(config.root);
  for (const repository of config.repositories) {
    const relevant = dirtyPaths?.filter(
      (path) =>
        path === repository.name || path.startsWith(`${repository.name}/`),
    );
    objects.batch(() => {
      const incremental =
        dirtyPaths === undefined
          ? null
          : scanDirtyRepository(
              config,
              repository,
              state,
              objects,
              ignore,
              relevant ?? [],
            );
      const scanned =
        incremental === null
          ? scanRepository(
              config,
              repository,
              state,
              objects,
              ignore,
              forceHash,
            )
          : incremental.scanned;
      scans.set(repository.name, scanned);
      counters.scanned += scanned.length;
      drafts.push(
        ...(incremental === null
          ? diffRepository(repository, state, scanned, ignore)
          : incremental.drafts),
      );
      const gitDraft =
        incremental === null || incremental.gitDirty
          ? captureGitDraft(config, repository, state, objects)
          : null;
      if (gitDraft !== null) drafts.push(gitDraft);
    });
  }
  queueDrafts(config, state, drafts);
  await flushOutbox(state, objects, connected, counters);

  const checkpoint = await connected.checkpoint(config.folderId);
  assertCheckpointMatches(config, checkpoint);
  const desired = buildDesiredEntries(config, checkpoint);
  const manifestIds = [
    ...desired
      .map((entry) => entry.manifestId)
      .filter((id): id is string => id !== null),
    ...checkpoint.gitStates
      .map((entry) => entry.manifestId)
      .filter((id): id is string => id !== null),
  ];
  addTransfer(
    counters,
    "download",
    await pullManifestClosure(manifestIds, connected, objects),
  );

  for (const repository of config.repositories) {
    const repositoryDesired = desired.filter(
      (entry) => entry.repository === repository.name,
    );
    const scanned = scans.get(repository.name) ?? [];
    counters.applied += applyRepository(
      config,
      repository,
      state,
      objects,
      repositoryDesired,
      scanned,
    );
    const gitState = checkpoint.gitStates.find(
      (value) => value.repository === repository.name,
    );
    if (gitState === undefined)
      throw new Error(`Hub omitted Git state: ${repository.name}`);
    counters.applied += applyGitState(
      config,
      repository,
      state,
      objects,
      gitState,
    );
  }
  state.setCursor(checkpoint.sequence);
  const conflicts = await connected.conflicts(config.folderId);
  state.storeConflicts(conflicts);
  const livePaths = new Set(
    desired.map((entry) => `${entry.repository}/${entry.path}`),
  );
  const active = conflicts.filter(
    (conflict) =>
      conflict.resolvedAt === undefined &&
      (conflict.kind === "git" ||
        (conflict.conflictPath !== null &&
          livePaths.has(`${conflict.repository}/${conflict.conflictPath}`))),
  );
  return summary(
    config,
    counters,
    checkpoint.sequence,
    active.length > 0 ? "conflict" : "clean",
    reasons,
    active.length,
  );
}

async function recoverInitialJoinState(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  connected: HubTransport,
  counters: Counters,
  checkpoint: Checkpoint,
): Promise<boolean> {
  const desired = buildDesiredEntries(config, checkpoint);
  const manifestIds = [
    ...desired
      .map((entry) => entry.manifestId)
      .filter((id): id is string => id !== null),
    ...checkpoint.gitStates
      .map((entry) => entry.manifestId)
      .filter((id): id is string => id !== null),
  ];
  addTransfer(
    counters,
    "download",
    await pullManifestClosure(manifestIds, connected, objects),
  );
  const ignore = readIgnorePatterns(config.root);
  let needsReconcile = false;
  for (const repository of config.repositories) {
    const repositoryDesired = desired.filter(
      (entry) => entry.repository === repository.name,
    );
    const desiredByPath = new Map(
      repositoryDesired.map((entry) => [entry.path, entry]),
    );
    const scanned = objects.batch(() =>
      scanRepository(config, repository, state, objects, ignore, true),
    );
    counters.scanned += scanned.length;
    const aligned = scanned.map((entry) => {
      const accepted = desiredByPath.get(entry.path);
      const exact =
        accepted !== undefined &&
        accepted.kind === entry.kind &&
        accepted.manifestId === entry.manifestId;
      if (!exact) needsReconcile = true;
      return exact
        ? {
            ...entry,
            parentNodeId: accepted.parentNodeId,
            name: accepted.name,
            nodeId: accepted.nodeId,
          }
        : entry;
    });
    counters.applied += applyRepository(
      config,
      repository,
      state,
      objects,
      repositoryDesired,
      aligned,
      false,
    );
    const git = checkpoint.gitStates.find(
      (value) => value.repository === repository.name,
    );
    if (git === undefined)
      throw new Error(`Hub omitted Git state: ${repository.name}`);
    if (pathExists(join(config.root, repository.name, ".git")))
      needsReconcile = true;
    counters.applied += applyGitState(config, repository, state, objects, git);
  }
  flushFilesystem(config.root);
  state.setCursor(checkpoint.sequence);
  state.completeInitialJoin();
  return needsReconcile;
}

async function syncIncrementalConnected(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  connected: HubTransport,
  counters: Counters,
  reasons: string[],
  dirtyPaths: readonly string[],
): Promise<SyncSummary> {
  const drafts: EventDraft[] = [];
  const scannedByNode = new Map<string, ScannedEntry>();
  const ignore = readIgnorePatterns(config.root);
  for (const repository of config.repositories) {
    const relevant = dirtyPaths.filter(
      (path) =>
        path === repository.name || path.startsWith(`${repository.name}/`),
    );
    if (relevant.length === 0) continue;
    objects.batch(() => {
      const incremental = scanDirtyRepository(
        config,
        repository,
        state,
        objects,
        ignore,
        relevant,
      );
      counters.scanned += incremental.scanned.length;
      for (const scanned of incremental.scanned)
        scannedByNode.set(scanned.nodeId, scanned);
      drafts.push(...incremental.drafts);
      if (incremental.gitDirty) {
        const gitDraft = captureGitDraft(config, repository, state, objects);
        if (gitDraft !== null) drafts.push(gitDraft);
      }
    });
  }
  if (
    drafts.length > maximumEventBatch ||
    drafts.some(
      (draft) =>
        draft.mutation.kind !== "git-state" &&
        (draft.mutation.kind !== "put" ||
          draft.mutation.nodeKind === "directory"),
    )
  ) {
    return syncConnected(config, state, objects, connected, counters, reasons);
  }
  const events = queueDrafts(config, state, drafts);
  const own = new Map<string, OwnPublished>();
  for (const event of events) {
    own.set(
      event.eventId,
      event.mutation.kind === "git-state"
        ? "git"
        : (scannedByNode.get(event.mutation.nodeId) ?? "git"),
    );
  }
  const exchange =
    events.length === 0
      ? null
      : await flushIncrementalOutbox(
          config,
          state,
          objects,
          connected,
          counters,
        );
  if (
    !(await applyRemoteChanges(
      config,
      state,
      objects,
      connected,
      counters,
      own,
      exchange?.changes,
    ))
  ) {
    return syncConnected(config, state, objects, connected, counters, reasons);
  }
  const conflicts =
    exchange?.conflicts ?? (await connected.conflicts(config.folderId));
  state.storeConflicts(conflicts);
  const active = activeLocalConflicts(state, conflicts);
  return summary(
    config,
    counters,
    state.cursor(),
    active > 0 ? "conflict" : "clean",
    reasons,
    active,
  );
}

/**
 * A crash can happen after the first outbox is accepted but before the local
 * checkpoint is installed. Rebuild that baseline from exact path+manifest
 * matches. Mismatches deliberately retain null observations so the next scan
 * publishes the changed local version against the accepted causal base.
 */
async function recoverInitialPublicationState(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  connected: HubTransport,
  counters: Counters,
): Promise<void> {
  const checkpoint = await connected.checkpoint(config.folderId);
  assertCheckpointMatches(config, checkpoint);
  const desired = buildDesiredEntries(config, checkpoint);
  const ignore = readIgnorePatterns(config.root);
  for (const repository of config.repositories) {
    const scanned = objects.batch(() =>
      scanRepository(config, repository, state, objects, ignore, true),
    );
    counters.scanned += scanned.length;
    const localByPath = new Map(scanned.map((entry) => [entry.path, entry]));
    state.replaceAllEntries(
      repository.name,
      desired
        .filter((entry) => entry.repository === repository.name)
        .map((entry) => {
          const local = localByPath.get(entry.path);
          return local !== undefined &&
            local.kind === entry.kind &&
            local.manifestId === entry.manifestId
            ? {
                ...entry,
                device: local.device,
                inode: local.inode,
                observedSize: local.observedSize,
                observedMtimeMs: local.observedMtimeMs,
                observedCtimeMs: local.observedCtimeMs,
                observedMode: local.observedMode,
              }
            : entry;
        }),
    );
    const git = checkpoint.gitStates.find(
      (value) => value.repository === repository.name,
    );
    if (git === undefined)
      throw new Error(`Hub omitted Git state: ${repository.name}`);
    state.setGitState(git);
  }
  state.setCursor(checkpoint.sequence);
}

async function applyRemoteChanges(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  counters: Counters,
  own: ReadonlyMap<string, OwnPublished> = new Map(),
  initialBatch?: ChangeBatch,
): Promise<boolean> {
  let supplied = initialBatch;
  for (;;) {
    const batch =
      supplied ?? (await transport.changes(config.folderId, state.cursor()));
    supplied = undefined;
    if (batch.changes.length === 0) return true;
    if (
      batch.changes.some(
        ({ event }) => !fastMutationSupported(event.mutation, state),
      )
    )
      return false;
    const manifests = batch.changes.flatMap(({ event, result }) => {
      if (event.mutation.kind === "put" && event.mutation.manifestId !== null)
        return [event.mutation.manifestId];
      if (
        event.mutation.kind === "git-state" &&
        result.disposition === "canonical"
      ) {
        return [event.mutation.manifestId];
      }
      return [];
    });
    addTransfer(
      counters,
      "download",
      await pullManifestClosure(manifests, transport, objects),
    );
    for (const change of batch.changes) {
      const local = own.get(change.event.eventId);
      const applied =
        local === undefined
          ? applyFastChange(config, state, objects, change.event, change.result)
          : applyOwnPublished(state, change.event, change.result, local);
      if (!applied) return false;
      counters.applied += change.result.disposition === "coalesced" ? 0 : 1;
      state.setCursor(change.result.hubSequence);
    }
    if (!batch.hasMore) return true;
  }
}

function applyOwnPublished(
  state: LocalState,
  event: EventRequest,
  result: EventResult,
  published: OwnPublished,
): boolean {
  if (result.disposition !== "canonical" && result.disposition !== "coalesced")
    return false;
  if (event.mutation.kind === "git-state") {
    if (result.contentVersion === null || published !== "git") return false;
    state.setGitState({
      repository: event.mutation.repository,
      manifestId: event.mutation.manifestId,
      version: result.contentVersion,
    });
    return true;
  }
  if (
    event.mutation.kind !== "put" ||
    published === "git" ||
    result.path === null ||
    result.nodeId === null ||
    result.entryVersion === null ||
    result.contentVersion === null ||
    result.path !== published.path ||
    result.nodeId !== published.nodeId
  )
    return false;
  // The user may save again while this accepted version is in flight. Advance
  // the causal baseline to the accepted manifest but retain that version's old
  // observation. A newer on-disk stat then remains dirty and publishes next
  // from the correct content version instead of becoming a false conflict.
  state.replaceEntry({
    repository: published.repository,
    path: published.path,
    parentNodeId: published.parentNodeId,
    name: published.name,
    nodeId: published.nodeId,
    entryVersion: result.entryVersion,
    kind: published.kind,
    manifestId: published.manifestId,
    contentVersion: result.contentVersion,
    device: published.device,
    inode: published.inode,
    observedSize: published.observedSize,
    observedMtimeMs: published.observedMtimeMs,
    observedCtimeMs: published.observedCtimeMs,
    observedMode: published.observedMode,
  });
  return true;
}

function fastMutationSupported(mutation: Mutation, state: LocalState): boolean {
  if (mutation.kind === "git-state") return true;
  const existing = state.getEntryByNode(mutation.repository, mutation.nodeId);
  if (mutation.kind === "put") return mutation.nodeKind !== "directory";
  if (mutation.kind === "delete") return existing?.kind !== "directory";
  return existing?.kind !== "directory";
}

function applyFastChange(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  event: EventRequest,
  result: EventResult,
): boolean {
  const mutation = event.mutation;
  if (result.disposition === "coalesced") return true;
  if (mutation.kind === "git-state") {
    if (result.disposition !== "canonical") return true;
    if (result.contentVersion === null) return false;
    const repository = config.repositories.find(
      (value) => value.name === mutation.repository,
    );
    if (repository === undefined) return false;
    const current = state.getGitState(repository.name);
    if (current.manifestId !== null) {
      const gitPath = join(config.root, repository.name, ".git");
      if (!pathExists(gitPath)) return false;
      const captured = captureTree(gitPath, objects);
      if (captured.manifestId !== current.manifestId) return false;
    }
    applyGitState(config, repository, state, objects, {
      repository: repository.name,
      manifestId: mutation.manifestId,
      version: result.contentVersion,
    });
    return true;
  }
  if (mutation.kind === "put") {
    if (result.path === null || result.nodeId === null) return false;
    if (result.entryVersion === null || result.contentVersion === null)
      return false;
    const repository = config.repositories.find(
      (value) => value.name === mutation.repository,
    );
    if (repository === undefined || mutation.manifestId === null) return false;
    const existing = state.getEntryByNode(mutation.repository, result.nodeId);
    if (existing !== null && !localEntryUnchanged(config, existing))
      return false;
    const parentPath = dirname(result.path).replaceAll(sep, "/");
    const parentNodeId =
      parentPath === "."
        ? repository.rootNodeId
        : state.getEntry(mutation.repository, parentPath)?.nodeId;
    if (parentNodeId === undefined) return false;
    const target = safeTarget(join(config.root, repository.name), result.path);
    if (existing === null && pathExists(target)) return false;
    if (existing !== null && existing.path !== result.path) {
      const source = safeTarget(
        join(config.root, repository.name),
        existing.path,
      );
      if (pathExists(source) && !pathExists(target)) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        journaledRename(config, state, source, target);
      }
    }
    const desired: LocalEntry = {
      repository: mutation.repository,
      path: result.path,
      parentNodeId,
      name: result.path.split("/").at(-1) ?? mutation.name,
      nodeId: result.nodeId,
      entryVersion: result.entryVersion,
      kind: mutation.nodeKind,
      manifestId: mutation.manifestId,
      contentVersion: result.contentVersion,
      device: null,
      inode: null,
      observedSize: null,
      observedMtimeMs: null,
      observedCtimeMs: null,
      observedMode: null,
    };
    if (
      existing === null ||
      existing.manifestId !== desired.manifestId ||
      existing.path !== desired.path ||
      !pathExists(target)
    ) {
      applyLeaf(
        config,
        state,
        objects,
        mutation.manifestId,
        target,
        repository.name,
      );
    }
    state.replaceEntry(
      observeApplied(join(config.root, repository.name), desired),
    );
    return true;
  }
  const existing = state.getEntryByNode(mutation.repository, mutation.nodeId);
  if (mutation.kind === "delete") {
    if (result.disposition !== "canonical") return true;
    if (existing === null) return true;
    if (!localEntryUnchanged(config, existing)) return false;
    const target = safeTarget(
      join(config.root, mutation.repository),
      existing.path,
    );
    if (pathExists(target))
      moveToRecovery(
        config,
        state,
        target,
        `remote-delete-${mutation.repository}`,
      );
    state.removeEntry(mutation.repository, existing.path);
    return true;
  }
  if (result.path === null || result.entryVersion === null || existing === null)
    return false;
  if (!localEntryUnchanged(config, existing)) return false;
  if (result.disposition !== "canonical") return false;
  const repository = config.repositories.find(
    (value) => value.name === mutation.repository,
  );
  if (repository === undefined) return false;
  const source = safeTarget(join(config.root, repository.name), existing.path);
  const target = safeTarget(join(config.root, repository.name), result.path);
  if (pathExists(source) && !pathExists(target)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    journaledRename(config, state, source, target);
  }
  state.removeEntry(existing.repository, existing.path);
  state.replaceEntry(
    observeApplied(join(config.root, repository.name), {
      ...existing,
      path: result.path,
      name: result.path.split("/").at(-1) ?? mutation.toName,
      parentNodeId:
        dirname(result.path) === "."
          ? repository.rootNodeId
          : (state.getEntry(
              repository.name,
              dirname(result.path).replaceAll(sep, "/"),
            )?.nodeId ?? mutation.toParentNodeId),
      entryVersion: result.entryVersion,
    }),
  );
  return true;
}

function localEntryUnchanged(
  config: ProductConfig,
  entry: LocalEntry,
): boolean {
  const target = safeTarget(join(config.root, entry.repository), entry.path);
  if (!pathExists(target)) return false;
  const stat = lstatSync(target);
  return (
    stat.dev === entry.device &&
    stat.ino === entry.inode &&
    stat.size === entry.observedSize &&
    stat.mtimeMs === entry.observedMtimeMs &&
    stat.ctimeMs === entry.observedCtimeMs &&
    stat.mode === entry.observedMode
  );
}

function activeLocalConflicts(
  state: LocalState,
  conflicts: readonly ConflictRecord[],
): number {
  return conflicts.filter(
    (conflict) =>
      conflict.resolvedAt === undefined &&
      (conflict.kind === "git" ||
        (conflict.conflictPath !== null &&
          state.getEntry(conflict.repository, conflict.conflictPath) !== null)),
  ).length;
}

export async function statusV2(config: ProductConfig): Promise<{
  readonly summary: SyncSummary;
  readonly outbox: number;
  readonly conflicts: readonly ConflictRecord[];
  readonly repositories: readonly {
    readonly name: string;
    readonly trackedPaths: number;
    readonly gitVersion: string | null;
  }[];
}> {
  ensureLocalLayout(config);
  using state = new LocalState(config);
  const conflicts = state.conflicts();
  const repositories = config.repositories.map((repository) => ({
    name: repository.name,
    trackedPaths: state.entryCount(repository.name),
    gitVersion: state.getGitState(repository.name).version,
  }));
  let remoteSequence = state.cursor();
  let status: SyncSummary["status"] =
    state.outboxCount() > 0 ? "offline" : "clean";
  const reasons: string[] = [];
  try {
    await using transport = await HubTransport.connect(config.hub);
    const checkpoint = await transport.checkpoint(config.folderId);
    assertCheckpointMatches(config, checkpoint);
    remoteSequence = checkpoint.sequence;
    if (remoteSequence !== state.cursor() || state.outboxCount() > 0)
      status = "inconclusive";
    const desired = buildDesiredEntries(config, checkpoint);
    const live = new Set(
      desired.map((entry) => `${entry.repository}/${entry.path}`),
    );
    if (
      conflicts.some(
        (conflict) =>
          conflict.resolvedAt === undefined &&
          (conflict.kind === "git" ||
            (conflict.conflictPath !== null &&
              live.has(`${conflict.repository}/${conflict.conflictPath}`))),
      )
    ) {
      status = "conflict";
    }
  } catch (error) {
    status = "offline";
    reasons.push(message(error));
  }
  return {
    summary: summary(
      config,
      emptyCounters(),
      remoteSequence,
      status,
      reasons,
      conflicts.length,
    ),
    outbox: state.outboxCount(),
    conflicts,
    repositories,
  };
}

export async function historyV2(
  config: ProductConfig,
  repository?: string,
): Promise<
  readonly { readonly event: EventRequest; readonly result: EventResult }[]
> {
  await using transport = await HubTransport.connect(config.hub);
  return transport.history(config.folderId, repository);
}

export async function recoverManifestV2(
  config: ProductConfig,
  manifestId: string,
  destination: string,
): Promise<void> {
  ensureLocalLayout(config);
  const absolute = resolve(destination);
  if (existsSync(absolute))
    throw new Error(`Recovery destination exists: ${absolute}`);
  using store = new ObjectStore(join(config.stateDir, "objects"));
  if (!store.has(manifestId)) {
    await using transport = await HubTransport.connect(config.hub);
    await pullManifestClosure([manifestId], transport, store);
  }
  materializeManifest(manifestId, absolute, store);
}

export async function resolveGitConflictV2(
  config: ProductConfig,
  conflictId: string,
  take: "canonical" | "conflict",
): Promise<SyncSummary> {
  ensureLocalLayout(config);
  const objects = new ObjectStore(join(config.stateDir, "objects"));
  using state = new LocalState(config);
  await using transport = await HubTransport.connect(config.hub);
  const conflict = (await transport.conflicts(config.folderId)).find(
    (value) => value.conflictId === conflictId,
  );
  if (conflict === undefined || conflict.kind !== "git")
    throw new Error(`Unknown Git conflict: ${conflictId}`);
  if (conflict.resolvedAt !== undefined)
    throw new Error("Git conflict is already resolved");
  if (take === "conflict") {
    if (conflict.manifestId === null)
      throw new Error("Git conflict has no manifest");
    const checkpoint = await transport.checkpoint(config.folderId);
    const current = checkpoint.gitStates.find(
      (value) => value.repository === conflict.repository,
    );
    if (current === undefined) throw new Error("Current Git state is missing");
    await pullManifestClosure([conflict.manifestId], transport, objects);
    queueDrafts(config, state, [
      {
        mutation: {
          kind: "git-state",
          repository: conflict.repository,
          baseVersion: current.version,
          manifestId: conflict.manifestId,
        },
        objectIds: referencedObjects(conflict.manifestId, objects),
      },
    ]);
    await flushOutbox(state, objects, transport, emptyCounters());
  }
  await transport.resolveConflict(config.folderId, conflictId, take);
  return await syncConnected(
    config,
    state,
    objects,
    transport,
    emptyCounters(),
    [],
    [],
  );
}

function scanRepository(
  config: ProductConfig,
  repository: RepositoryConfig,
  state: LocalState,
  objects: ObjectStore,
  ignorePatterns: readonly string[],
  forceHash = false,
): readonly ScannedEntry[] {
  const root = join(config.root, repository.name);
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error(`Repository root is unsafe: ${repository.name}`);
  const baseline = state.getEntries(repository.name);
  const byPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const byIdentity = new Map(
    baseline
      .filter((entry) => entry.device !== null && entry.inode !== null)
      .map((entry) => [`${entry.device}:${entry.inode}`, entry]),
  );
  const claimed = new Set<string>();
  const result: ScannedEntry[] = [];

  const walk = (
    directory: string,
    relativeDirectory: string,
    parentNodeId: string,
  ) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    );
    for (const directoryEntry of entries) {
      if (relativeDirectory.length === 0 && directoryEntry.name === ".git")
        continue;
      const path =
        relativeDirectory.length === 0
          ? directoryEntry.name
          : `${relativeDirectory}/${directoryEntry.name}`;
      normalizeRelativePath(path);
      if (isIgnored(`${repository.name}/${path}`, ignorePatterns)) continue;
      const target = join(directory, directoryEntry.name);
      const stat = lstatSync(target);
      const exact = byPath.get(path) ?? null;
      const identity = byIdentity.get(`${stat.dev}:${stat.ino}`) ?? null;
      const inherited =
        exact ??
        (identity !== null && !claimed.has(identity.nodeId) ? identity : null);
      if (inherited !== null) claimed.add(inherited.nodeId);
      const kind = kindFromStat(stat, target);
      const reusable =
        !forceHash &&
        inherited !== null &&
        inherited.kind === kind &&
        inherited.observedSize === stat.size &&
        inherited.observedMtimeMs === stat.mtimeMs &&
        inherited.observedCtimeMs === stat.ctimeMs &&
        inherited.observedMode === stat.mode &&
        inherited.manifestId !== null;
      const captured: CaptureResult =
        kind === "directory"
          ? {
              kind,
              manifestId: null,
              objectIds: [],
              device: stat.dev,
              inode: stat.ino,
            }
          : reusable
            ? {
                kind,
                manifestId: inherited.manifestId,
                objectIds: [inherited.manifestId],
                device: stat.dev,
                inode: stat.ino,
              }
            : capturePath(target, objects);
      const scanned: ScannedEntry = {
        repository: repository.name,
        path,
        parentNodeId,
        name: directoryEntry.name,
        nodeId: inherited?.nodeId ?? randomUUID(),
        kind,
        manifestId: captured.manifestId,
        objectIds:
          reusable && captured.manifestId !== null
            ? referencedLocalObjects(captured.manifestId, objects)
            : captured.objectIds,
        device: stat.dev,
        inode: stat.ino,
        observedSize: stat.size,
        observedMtimeMs: stat.mtimeMs,
        observedCtimeMs: stat.ctimeMs,
        observedMode: stat.mode,
        baseline: inherited,
      };
      result.push(scanned);
      if (kind === "directory") walk(target, path, scanned.nodeId);
    }
  };
  walk(root, "", repository.rootNodeId);
  return result;
}

function scanDirtyRepository(
  config: ProductConfig,
  repository: RepositoryConfig,
  state: LocalState,
  objects: ObjectStore,
  ignorePatterns: readonly string[],
  dirtyPaths: readonly string[],
): {
  readonly scanned: readonly ScannedEntry[];
  readonly drafts: readonly EventDraft[];
  readonly gitDirty: boolean;
} {
  const repositoryRoot = join(config.root, repository.name);
  let gitDirty = false;
  const relativePaths = new Set<string>();
  for (const dirty of dirtyPaths) {
    const relative =
      dirty === repository.name ? "" : dirty.slice(repository.name.length + 1);
    if (
      relative
        .split("/")
        .some((part) => /^\.codefoldersync(?:-|$)/iu.test(part))
    )
      continue;
    if (relative === ".git" || relative.startsWith(".git/")) {
      gitDirty = true;
      continue;
    }
    if (relative.length > 0) relativePaths.add(normalizeRelativePath(relative));
  }
  if (relativePaths.size === 0) return { scanned: [], drafts: [], gitDirty };
  const orderedDirty = [...relativePaths].sort(
    (left, right) =>
      Number(pathExists(safeTarget(repositoryRoot, right))) -
      Number(pathExists(safeTarget(repositoryRoot, left))),
  );
  for (const path of orderedDirty) {
    const target = safeTarget(repositoryRoot, path);
    if (
      (pathExists(target) && lstatSync(target).isDirectory()) ||
      dirname(path) !== "."
    ) {
      const parent = dirname(path).replaceAll(sep, "/");
      if (pathExists(target) && lstatSync(target).isDirectory()) {
        const scanned = scanRepository(
          config,
          repository,
          state,
          objects,
          ignorePatterns,
        );
        return {
          scanned,
          drafts: diffRepository(repository, state, scanned, ignorePatterns),
          gitDirty,
        };
      }
      if (
        parent !== "." &&
        state.getEntry(repository.name, parent) === null &&
        !pathExists(join(repositoryRoot, parent))
      ) {
        const scanned = scanRepository(
          config,
          repository,
          state,
          objects,
          ignorePatterns,
        );
        return {
          scanned,
          drafts: diffRepository(repository, state, scanned, ignorePatterns),
          gitDirty,
        };
      }
    }
  }

  const scanned: ScannedEntry[] = [];
  const drafts: EventDraft[] = [];
  const handledNodes = new Set<string>();
  for (const path of orderedDirty) {
    if (isIgnored(`${repository.name}/${path}`, ignorePatterns)) continue;
    const target = safeTarget(repositoryRoot, path);
    const exact = state.getEntry(repository.name, path);
    if (!pathExists(target)) {
      if (exact !== null && !handledNodes.has(exact.nodeId)) {
        handledNodes.add(exact.nodeId);
        drafts.push({
          mutation: {
            kind: "delete",
            repository: repository.name,
            nodeId: exact.nodeId,
            parentNodeId: exact.parentNodeId,
            name: exact.name,
            baseEntryVersion: exact.entryVersion,
            baseContentVersion: exact.contentVersion,
          },
          objectIds: [],
        });
      }
      continue;
    }
    const stat = lstatSync(target);
    const kind = kindFromStat(stat, target);
    if (kind === "directory") continue;
    const identity = state.getEntryByIdentity(
      repository.name,
      stat.dev,
      stat.ino,
    );
    const inherited = exact ?? identity;
    if (inherited !== null && handledNodes.has(inherited.nodeId)) continue;
    const parentPath = dirname(path).replaceAll(sep, "/");
    const parentNodeId =
      parentPath === "."
        ? repository.rootNodeId
        : state.getEntry(repository.name, parentPath)?.nodeId;
    if (parentNodeId === undefined) {
      const full = scanRepository(
        config,
        repository,
        state,
        objects,
        ignorePatterns,
      );
      return {
        scanned: full,
        drafts: diffRepository(repository, state, full, ignorePatterns),
        gitDirty,
      };
    }
    const reusable =
      inherited !== null &&
      inherited.kind === kind &&
      inherited.observedSize === stat.size &&
      inherited.observedMtimeMs === stat.mtimeMs &&
      inherited.observedCtimeMs === stat.ctimeMs &&
      inherited.observedMode === stat.mode &&
      inherited.manifestId !== null;
    const captured = reusable
      ? {
          kind,
          manifestId: inherited.manifestId,
          objectIds: referencedLocalObjects(inherited.manifestId, objects),
          device: stat.dev,
          inode: stat.ino,
        }
      : capturePath(target, objects);
    const name = path.split("/").at(-1);
    if (name === undefined) throw new Error(`Invalid dirty path: ${path}`);
    const value: ScannedEntry = {
      repository: repository.name,
      path,
      parentNodeId,
      name,
      nodeId: inherited?.nodeId ?? randomUUID(),
      kind,
      manifestId: captured.manifestId,
      objectIds: captured.objectIds,
      device: stat.dev,
      inode: stat.ino,
      observedSize: stat.size,
      observedMtimeMs: stat.mtimeMs,
      observedCtimeMs: stat.ctimeMs,
      observedMode: stat.mode,
      baseline: inherited,
    };
    scanned.push(value);
    handledNodes.add(value.nodeId);
    if (inherited === null) {
      drafts.push({
        mutation: {
          kind: "put",
          repository: repository.name,
          nodeId: value.nodeId,
          nodeKind: value.kind,
          parentNodeId: value.parentNodeId,
          name: value.name,
          baseEntryVersion: null,
          baseContentVersion: null,
          manifestId: value.manifestId,
        },
        objectIds: value.objectIds,
      });
      continue;
    }
    if (inherited.parentNodeId !== parentNodeId || inherited.name !== name) {
      drafts.push({
        mutation: {
          kind: "rename",
          repository: repository.name,
          nodeId: inherited.nodeId,
          fromParentNodeId: inherited.parentNodeId,
          fromName: inherited.name,
          toParentNodeId: parentNodeId,
          toName: name,
          baseEntryVersion: inherited.entryVersion,
        },
        objectIds: [],
      });
    }
    if (inherited.kind !== kind || inherited.manifestId !== value.manifestId) {
      drafts.push({
        mutation: {
          kind: "put",
          repository: repository.name,
          nodeId: inherited.nodeId,
          nodeKind: kind,
          parentNodeId,
          name,
          baseEntryVersion: inherited.entryVersion,
          baseContentVersion: inherited.contentVersion,
          manifestId: value.manifestId,
        },
        objectIds: value.objectIds,
      });
    }
  }
  return { scanned, drafts, gitDirty };
}

function diffRepository(
  repository: RepositoryConfig,
  state: LocalState,
  scanned: readonly ScannedEntry[],
  ignorePatterns: readonly string[],
): readonly EventDraft[] {
  const drafts: EventDraft[] = [];
  const presentNodes = new Set(scanned.map((entry) => entry.nodeId));
  for (const entry of scanned) {
    const baseline = entry.baseline;
    if (baseline === null) {
      drafts.push({
        mutation: {
          kind: "put",
          repository: repository.name,
          nodeId: entry.nodeId,
          nodeKind: entry.kind,
          parentNodeId: entry.parentNodeId,
          name: entry.name,
          baseEntryVersion: null,
          baseContentVersion: null,
          manifestId: entry.manifestId,
        },
        objectIds: entry.objectIds,
      });
      continue;
    }
    if (
      baseline.parentNodeId !== entry.parentNodeId ||
      baseline.name !== entry.name
    ) {
      drafts.push({
        mutation: {
          kind: "rename",
          repository: repository.name,
          nodeId: entry.nodeId,
          fromParentNodeId: baseline.parentNodeId,
          fromName: baseline.name,
          toParentNodeId: entry.parentNodeId,
          toName: entry.name,
          baseEntryVersion: baseline.entryVersion,
        },
        objectIds: [],
      });
    }
    if (
      baseline.kind !== entry.kind ||
      baseline.manifestId !== entry.manifestId
    ) {
      drafts.push({
        mutation: {
          kind: "put",
          repository: repository.name,
          nodeId: entry.nodeId,
          nodeKind: entry.kind,
          parentNodeId: entry.parentNodeId,
          name: entry.name,
          baseEntryVersion: baseline.entryVersion,
          baseContentVersion: baseline.contentVersion,
          manifestId: entry.manifestId,
        },
        objectIds: entry.objectIds,
      });
    }
  }
  const baseline = state.getEntries(repository.name);
  const missing = baseline.filter(
    (entry) =>
      !presentNodes.has(entry.nodeId) &&
      !isIgnored(`${repository.name}/${entry.path}`, ignorePatterns),
  );
  const missingNodes = new Set(missing.map((entry) => entry.nodeId));
  for (const entry of missing) {
    if (missingNodes.has(entry.parentNodeId)) continue;
    drafts.push({
      mutation: {
        kind: "delete",
        repository: repository.name,
        nodeId: entry.nodeId,
        parentNodeId: entry.parentNodeId,
        name: entry.name,
        baseEntryVersion: entry.entryVersion,
        baseContentVersion: entry.contentVersion,
      },
      objectIds: [],
    });
  }
  return drafts;
}

function captureGitDraft(
  config: ProductConfig,
  repository: RepositoryConfig,
  state: LocalState,
  objects: ObjectStore,
): EventDraft | null {
  const root = join(config.root, repository.name);
  const git = join(root, ".git");
  if (!existsSync(git)) return null;
  verifyGit(root);
  const captured = captureTree(git, objects);
  const baseline = state.getGitState(repository.name);
  if (baseline.manifestId === captured.manifestId) return null;
  return {
    mutation: {
      kind: "git-state",
      repository: repository.name,
      baseVersion: baseline.version,
      manifestId: captured.manifestId,
    },
    objectIds: captured.objectIds,
  };
}

function queueDrafts(
  config: ProductConfig,
  state: LocalState,
  drafts: readonly EventDraft[],
): readonly EventRequest[] {
  const sequences = state.reservePeerSequences(drafts.length);
  const now = new Date().toISOString();
  const events = drafts.map((draft, index) => {
    const peerSequence = sequences[index];
    if (peerSequence === undefined) throw new Error("Missing peer sequence");
    const event: EventRequest = {
      schemaVersion,
      eventId: randomUUID(),
      folderId: config.folderId,
      peerId: config.peerId,
      peerName: config.peerName,
      peerSequence,
      createdAt: now,
      mutation: draft.mutation,
    };
    return { event, objectIds: draft.objectIds };
  });
  state.queueEvents(events);
  return events.map((value) => value.event);
}

async function flushOutbox(
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  counters: Counters,
  advanceCursor = true,
): Promise<void> {
  const outbox = state.listOutbox();
  if (outbox.length === 0) return;
  const ids = [...new Set(outbox.flatMap((entry) => entry.objectIds))];
  addTransfer(counters, "upload", await transport.pushObjects(ids, objects));
  for (let offset = 0; offset < outbox.length; offset += maximumEventBatch) {
    const batch = outbox.slice(offset, offset + maximumEventBatch);
    const results = await transport.submitMany(
      batch.map((entry) => entry.event),
    );
    if (results.length !== batch.length)
      throw new Error("Hub omitted event results");
    state.acknowledgeMany(results, advanceCursor);
    counters.published += results.length;
  }
}

async function flushIncrementalOutbox(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  counters: Counters,
): Promise<PublishExchange> {
  const outbox = state.listOutbox();
  if (outbox.length === 0) throw new Error("Incremental outbox is empty");
  const allIds = [...new Set(outbox.flatMap((entry) => entry.objectIds))];
  const accepted = acceptedBaselineObjects(state, objects, outbox);
  const directIds = allIds.filter((id) => !accepted.has(id));
  const exchange = await transport.publish(
    config.folderId,
    state.cursor(),
    outbox.map((entry) => entry.event),
    directIds,
    objects,
  );
  if (exchange.results.length !== outbox.length)
    throw new Error("Hub omitted event results");
  state.acknowledgeMany(exchange.results, false);
  addTransfer(counters, "upload", exchange.transfer);
  counters.published += exchange.results.length;
  return exchange;
}

function acceptedBaselineObjects(
  state: LocalState,
  objects: ObjectStore,
  outbox: ReturnType<LocalState["listOutbox"]>,
): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const { event } of outbox) {
    const mutation = event.mutation;
    if (mutation.kind === "put") {
      const baseline = state.getEntryByNode(
        mutation.repository,
        mutation.nodeId,
      );
      if (baseline?.manifestId !== null && baseline?.manifestId !== undefined)
        roots.add(baseline.manifestId);
    } else if (mutation.kind === "git-state") {
      const baseline = state.getGitState(mutation.repository).manifestId;
      if (baseline !== null) roots.add(baseline);
    }
  }
  return localObjectClosure([...roots], objects);
}

function localObjectClosure(
  roots: readonly string[],
  objects: ObjectStore,
): ReadonlySet<string> {
  const pending = [...roots];
  const result = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || result.has(id)) continue;
    result.add(id);
    const manifest = objects.getManifest(id);
    if (manifest.type === "regular") {
      for (const chunk of manifest.chunks) result.add(chunk.id);
    } else if (manifest.type === "tree") {
      for (const entry of manifest.entries)
        if (entry.manifestId !== null) pending.push(entry.manifestId);
    }
  }
  return result;
}

function buildDesiredEntries(
  config: ProductConfig,
  checkpoint: Checkpoint,
): readonly LocalEntry[] {
  const nodes = new Map(
    checkpoint.nodes.map((node) => [`${node.repository}:${node.nodeId}`, node]),
  );
  const children = new Map<string, EntryRecord[]>();
  for (const entry of checkpoint.entries) {
    const key = `${entry.repository}:${entry.parentNodeId}`;
    const values = children.get(key) ?? [];
    values.push(entry);
    children.set(key, values);
  }
  const result: LocalEntry[] = [];
  for (const repository of config.repositories) {
    const visited = new Set<string>();
    const walk = (parentNodeId: string, parentPath: string) => {
      if (visited.has(parentNodeId)) throw new Error("Checkpoint node cycle");
      visited.add(parentNodeId);
      const aliases = new Set<string>();
      for (const entry of children.get(`${repository.name}:${parentNodeId}`) ??
        []) {
        const alias = normalizedEntryKey(entry.name);
        if (aliases.has(alias))
          throw new Error(`Checkpoint path collision: ${entry.name}`);
        aliases.add(alias);
        const node = nodes.get(`${repository.name}:${entry.nodeId}`);
        if (node === undefined)
          throw new Error(`Checkpoint node missing: ${entry.nodeId}`);
        const path =
          parentPath.length === 0 ? entry.name : `${parentPath}/${entry.name}`;
        normalizeRelativePath(path);
        result.push({
          ...entry,
          ...node,
          path,
          device: null,
          inode: null,
          observedSize: null,
          observedMtimeMs: null,
          observedCtimeMs: null,
          observedMode: null,
        });
        if (node.kind === "directory") walk(node.nodeId, path);
      }
    };
    walk(repository.rootNodeId, "");
  }
  return result;
}

function applyRepository(
  config: ProductConfig,
  repository: RepositoryConfig,
  state: LocalState,
  objects: ObjectStore,
  desired: readonly LocalEntry[],
  scanned: readonly ScannedEntry[],
  durableLeaves = true,
): number {
  const root = join(config.root, repository.name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  verifyNoSymlinkEscape(root);
  const baseline = state.getEntries(repository.name);
  const baselineByNode = new Map(
    baseline.map((entry) => [entry.nodeId, entry]),
  );
  const desiredByNode = new Map(desired.map((entry) => [entry.nodeId, entry]));
  const scannedByNode = new Map(scanned.map((entry) => [entry.nodeId, entry]));
  let applied = 0;

  for (const entry of [...desired].sort(
    (left, right) => depth(left.path) - depth(right.path),
  )) {
    const previous = baselineByNode.get(entry.nodeId);
    if (previous === undefined || previous.path === entry.path) continue;
    const source = safeTarget(root, previous.path);
    const target = safeTarget(root, entry.path);
    if (!pathExists(source) || pathExists(target)) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    journaledRename(config, state, source, target);
    applied += 1;
  }

  for (const entry of [...desired].sort(
    (left, right) => depth(left.path) - depth(right.path),
  )) {
    const target = safeTarget(root, entry.path);
    if (entry.kind === "directory") {
      if (pathExists(target)) {
        const stat = lstatSync(target);
        if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
        moveToRecovery(config, state, target, `type-${repository.name}`);
      }
      mkdirSync(target, { recursive: false, mode: 0o755 });
      applied += 1;
      continue;
    }
    if (entry.manifestId === null)
      throw new Error(`File manifest is missing: ${entry.path}`);
    const actual = scannedByNode.get(entry.nodeId);
    const previous = baselineByNode.get(entry.nodeId);
    if (
      pathExists(target) &&
      ((actual !== undefined && actual.manifestId === entry.manifestId) ||
        (previous !== undefined &&
          previous.path === entry.path &&
          previous.kind === entry.kind &&
          previous.manifestId === entry.manifestId))
    ) {
      continue;
    }
    applyLeaf(
      config,
      state,
      objects,
      entry.manifestId,
      target,
      repository.name,
      durableLeaves,
    );
    applied += 1;
  }

  for (const entry of [...baseline].sort(
    (left, right) => depth(right.path) - depth(left.path),
  )) {
    if (desiredByNode.has(entry.nodeId)) continue;
    const target = safeTarget(root, entry.path);
    if (!pathExists(target)) continue;
    moveToRecovery(config, state, target, `delete-${repository.name}`);
    applied += 1;
  }

  const updated = desired.map((entry) => {
    const actual = scannedByNode.get(entry.nodeId);
    if (
      actual !== undefined &&
      actual.path === entry.path &&
      actual.kind === entry.kind &&
      actual.manifestId === entry.manifestId
    ) {
      return {
        ...entry,
        device: actual.device,
        inode: actual.inode,
        observedSize: actual.observedSize,
        observedMtimeMs: actual.observedMtimeMs,
        observedCtimeMs: actual.observedCtimeMs,
        observedMode: actual.observedMode,
      };
    }
    const previous = baselineByNode.get(entry.nodeId);
    if (
      previous !== undefined &&
      previous.path === entry.path &&
      previous.kind === entry.kind &&
      previous.manifestId === entry.manifestId
    ) {
      return { ...entry, ...localObservation(previous) };
    }
    return observeApplied(root, entry);
  });
  state.replaceAllEntries(repository.name, updated);
  return applied;
}

function applyGitState(
  config: ProductConfig,
  repository: RepositoryConfig,
  state: LocalState,
  objects: ObjectStore,
  desired: GitStateRecord,
): number {
  const current = state.getGitState(repository.name);
  if (desired.manifestId === null || desired.version === null) return 0;
  const repositoryRoot = join(config.root, repository.name);
  const git = join(repositoryRoot, ".git");
  if (current.manifestId === desired.manifestId && existsSync(git)) return 0;
  const stage = join(
    config.stateDir,
    "staging",
    `git-${repository.name}-${randomUUID()}`,
  );
  materializeManifest(desired.manifestId, stage, objects);
  verifyGitDirectory(stage);
  const transactionId = randomUUID();
  const recovery = join(
    config.stateDir,
    "recovery",
    `git-${repository.name}-${transactionId}`,
  );
  state.beginApply(transactionId, { target: git, recovery });
  try {
    if (pathExists(git)) renameSync(git, recovery);
    renameSync(stage, git);
    verifyGit(repositoryRoot);
    state.finishApply(transactionId);
  } catch (error) {
    if (!pathExists(git) && pathExists(recovery)) renameSync(recovery, git);
    throw error;
  }
  state.setGitState(desired);
  return 1;
}

async function pullManifestClosure(
  roots: readonly string[],
  transport: HubTransport,
  store: ObjectStore,
): Promise<TransferStats> {
  const manifests = new Set(roots);
  const processed = new Set<string>();
  const chunks = new Set<string>();
  let objects = 0;
  let bytes = 0;
  while (processed.size < manifests.size) {
    const pending = [...manifests].filter((id) => !processed.has(id));
    const transfer = await transport.pullObjects(pending, store);
    objects += transfer.objects;
    bytes += transfer.bytes;
    for (const id of pending) {
      const manifest = store.getManifest(id);
      processed.add(id);
      if (manifest.type === "regular") {
        for (const chunk of manifest.chunks) chunks.add(chunk.id);
      } else if (manifest.type === "tree") {
        for (const entry of manifest.entries) {
          if (entry.manifestId !== null) manifests.add(entry.manifestId);
        }
      }
    }
  }
  const chunkTransfer = await transport.pullObjects([...chunks], store);
  return {
    objects: objects + chunkTransfer.objects,
    bytes: bytes + chunkTransfer.bytes,
  };
}

function referencedLocalObjects(
  manifestId: string,
  store: ObjectStore,
): readonly string[] {
  const manifest = store.getManifest(manifestId);
  return manifest.type === "regular"
    ? [manifestId, ...manifest.chunks.map((chunk) => chunk.id)]
    : [manifestId];
}

function applyLeaf(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  manifestId: string,
  target: string,
  repository: string,
  durable = true,
): void {
  if (!durable && !pathExists(target)) {
    // The durable initial-join marker and immutable local object store cover
    // the whole bulk apply. A single filesystem flush closes the marker after
    // all repositories are present, avoiding two SQLite journal commits per
    // tiny file while retaining restartability.
    materializeManifest(manifestId, target, objects, false);
    return;
  }
  const transactionId = randomUUID();
  const recovery = join(
    config.stateDir,
    "recovery",
    `${repository}-${transactionId}`,
  );
  state.beginApply(transactionId, { target, recovery });
  try {
    if (pathExists(target)) {
      mkdirSync(dirname(recovery), { recursive: true, mode: 0o700 });
      renameSync(target, recovery);
    }
    materializeManifest(manifestId, target, objects, durable);
    state.finishApply(transactionId);
  } catch (error) {
    if (!pathExists(target) && pathExists(recovery))
      renameSync(recovery, target);
    throw error;
  }
}

function flushFilesystem(path: string): void {
  const result = spawnSync(
    "sync",
    process.platform === "linux" ? ["-f", path] : [],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Filesystem flush failed: ${(result.stderr || result.stdout).trim()}`,
    );
}

function moveToRecovery(
  config: ProductConfig,
  state: LocalState,
  target: string,
  label: string,
): void {
  const transactionId = randomUUID();
  const recovery = join(
    config.stateDir,
    "recovery",
    `${label}-${transactionId}`,
  );
  state.beginApply(transactionId, { target, recovery });
  mkdirSync(dirname(recovery), { recursive: true, mode: 0o700 });
  renameSync(target, recovery);
  state.finishApply(transactionId);
}

function journaledRename(
  config: ProductConfig,
  state: LocalState,
  source: string,
  target: string,
): void {
  const transactionId = randomUUID();
  state.beginApply(transactionId, {
    kind: "rename",
    source,
    destination: target,
  });
  renameSync(source, target);
  state.finishApply(transactionId);
}

function recoverInterruptedApplies(
  config: ProductConfig,
  state: LocalState,
): void {
  for (const pending of state.pendingApplies()) {
    const input = pending.payload;
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error(`Invalid apply journal: ${pending.transactionId}`);
    const value = input as Record<string, unknown>;
    if (value.kind === "rename") {
      if (
        typeof value.source !== "string" ||
        typeof value.destination !== "string"
      )
        throw new Error(`Invalid rename journal: ${pending.transactionId}`);
      assertInside(config.root, value.source);
      assertInside(config.root, value.destination);
      if (!pathExists(value.source) && pathExists(value.destination)) {
        mkdirSync(dirname(value.source), { recursive: true, mode: 0o755 });
        renameSync(value.destination, value.source);
      }
      state.finishApply(pending.transactionId);
      continue;
    }
    if (typeof value.target !== "string" || typeof value.recovery !== "string")
      throw new Error(`Invalid apply paths: ${pending.transactionId}`);
    assertInside(config.root, value.target);
    assertInside(config.stateDir, value.recovery);
    if (!pathExists(value.target) && pathExists(value.recovery)) {
      mkdirSync(dirname(value.target), { recursive: true, mode: 0o755 });
      renameSync(value.recovery, value.target);
    }
    state.finishApply(pending.transactionId);
  }
}

function observeApplied(root: string, entry: LocalEntry): LocalEntry {
  const path = safeTarget(root, entry.path);
  const stat = lstatSync(path);
  return {
    ...entry,
    device: stat.dev,
    inode: stat.ino,
    observedSize: stat.size,
    observedMtimeMs: stat.mtimeMs,
    observedCtimeMs: stat.ctimeMs,
    observedMode: stat.mode,
  };
}

function localObservation(
  entry: LocalEntry,
): Pick<
  LocalEntry,
  | "device"
  | "inode"
  | "observedSize"
  | "observedMtimeMs"
  | "observedCtimeMs"
  | "observedMode"
> {
  return {
    device: entry.device,
    inode: entry.inode,
    observedSize: entry.observedSize,
    observedMtimeMs: entry.observedMtimeMs,
    observedCtimeMs: entry.observedCtimeMs,
    observedMode: entry.observedMode,
  };
}

function assertSafeInitialState(
  config: ProductConfig,
  state: LocalState,
  checkpoint: Checkpoint,
): void {
  if (state.entryCount() > 0) return;
  if (state.initialJoinPending()) return;
  // A first publication queues every event before contacting the hub. On a
  // restart, the durable outbox and immutable objects are enough to resume;
  // local changes made during the outage become normal causal conflicts.
  if (state.hasPublicationHistory()) return;
  const remoteHasContent = checkpoint.entries.length > 0;
  const localHasContent = config.repositories.some((repository) => {
    const root = join(config.root, repository.name);
    return (
      existsSync(root) && readdirSync(root).some((name) => name !== ".git")
    );
  });
  const remoteHasGit = checkpoint.gitStates.some(
    (git) => git.manifestId !== null,
  );
  const localHasGit = config.repositories.some((repository) =>
    existsSync(join(config.root, repository.name, ".git")),
  );
  if ((remoteHasContent || remoteHasGit) && (localHasContent || localHasGit)) {
    throw new Error(
      "Local state is missing for a non-empty peer; join requires an empty target or recovery",
    );
  }
}

function assertCheckpointMatches(
  config: ProductConfig,
  checkpoint: Checkpoint,
): void {
  if (
    checkpoint.folder.folderId !== config.folderId ||
    checkpoint.folder.folderName !== config.folderName ||
    JSON.stringify(checkpoint.folder.repositories) !==
      JSON.stringify(config.repositories)
  ) {
    throw new Error("Hub folder metadata does not match local configuration");
  }
  if (
    JSON.stringify(checkpoint.folder.ignorePatterns) !==
    JSON.stringify(readIgnorePatterns(config.root))
  ) {
    throw new Error(
      "Ignore rules differ from the hub; run `codefoldersync ignore pull` or push",
    );
  }
}

function kindFromStat(stat: Stats, path: string): NodeKind {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "regular";
  if (stat.isSymbolicLink()) return "symlink";
  throw new Error(`Unsupported filesystem object: ${path}`);
}

function isIgnored(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => glob(pattern).test(path));
}

const globCache = new Map<string, RegExp>();

function glob(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character?.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&") ?? "";
    }
  }
  const expression = new RegExp(`^(?:${source})(?:/.*)?$`, "u");
  globCache.set(pattern, expression);
  return expression;
}

function verifyGit(root: string): void {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-C", root, "fsck", "--full"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Git validation failed for ${root}: ${result.stderr.trim()}`,
    );
}

function verifyGitDirectory(git: string): void {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", `--git-dir=${git}`, "fsck", "--full"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(`Staged Git validation failed: ${result.stderr.trim()}`);
}

function addTransfer(
  counters: Counters,
  direction: "upload" | "download",
  value: TransferStats,
): void {
  if (direction === "upload") {
    counters.uploadedObjects += value.objects;
    counters.uploadedBytes += value.bytes;
  } else {
    counters.downloadedObjects += value.objects;
    counters.downloadedBytes += value.bytes;
  }
}

function emptyCounters(): Counters {
  return {
    scanned: 0,
    published: 0,
    applied: 0,
    uploadedObjects: 0,
    uploadedBytes: 0,
    downloadedObjects: 0,
    downloadedBytes: 0,
  };
}

function summary(
  config: ProductConfig,
  counters: Counters,
  hubSequence: number,
  status: SyncSummary["status"],
  reasons: readonly string[],
  conflicts = 0,
): SyncSummary {
  return {
    folderId: config.folderId,
    peerId: config.peerId,
    scanned: counters.scanned,
    published: counters.published,
    applied: counters.applied,
    conflicts,
    uploadedObjects: counters.uploadedObjects,
    uploadedBytes: counters.uploadedBytes,
    downloadedObjects: counters.downloadedObjects,
    downloadedBytes: counters.downloadedBytes,
    hubSequence,
    status,
    reasons,
  };
}

function depth(path: string): number {
  return path.split("/").length;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
