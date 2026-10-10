import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertHash, canonicalJson, hashJson, hashText } from "../v2/hash.js";
import { compileIgnore, defaultIgnore } from "./ignore.js";
import {
  manifestObjectIds,
  combineScopedNamespace,
  projectNamespace,
  scopeIncludes,
  scanNamespace,
  semanticDigest,
  validateNamespaceManifest,
  validateNamespacePolicy,
  type ScanResult,
  type RepositoryScope,
} from "./catalog.js";
import {
  assertAuthority,
  authorityPrivateKey,
  ensureIgnore,
  ensureRuntimeLayout,
  peerPrivateKey,
  reviseConfig,
  saveConfig,
  signPayload,
  verifyConfig,
  verifyPayload,
} from "./config.js";
import {
  adoptionVerificationPayload,
  conflictPayload,
  snapshotPayload,
} from "./hub.js";
import {
  materializeManifest,
  ObjectStore,
  parseManifest,
  referencedObjects,
} from "./objects.js";
import {
  conflictPath,
  normalizeRelativePath,
  portableName,
  safeTarget,
} from "./paths.js";
import { contentVersion, deriveMutations } from "./mutations.js";
import { LocalState } from "./state.js";
import { HubTransport } from "./transport.js";
import { acquireGitLease, recoverGitLease } from "./git-lease.js";
import { prepareGitContexts } from "./git-context.js";
import {
  schemaVersion,
  type AdoptionClassification,
  type AdoptionDifference,
  type AdoptionPlan,
  type CatalogEntry,
  type ConflictRecord,
  type HubCheckpoint,
  type NamespaceManifest,
  type ProductConfig,
  type RepositoryContext,
  type SignedAdoptionVerification,
  type SignedConflict,
  type SignedSnapshot,
  type SyncSummary,
  type TreeManifest,
  type TreeManifestEntry,
} from "./types.js";
import {
  assertMatchingRepositoryContext,
  assertStableRepositoryContext,
  inspectRepositoryContext,
  isPlaintextEnvPath,
} from "./policy.js";

export type AdoptionFaultPoint =
  | "after-apply-journal"
  | "after-recovery-move"
  | "after-local-conflict"
  | "after-hub-conflict"
  | "after-recovery-audit"
  | "after-snapshot-apply"
  | "after-hub-verification"
  | "after-complete-marker";

export interface AdoptionApplyOptions {
  readonly fault?: (point: AdoptionFaultPoint, path: string | null) => void;
}

export type NormalApplyFaultPoint =
  | "after-outbox"
  | "after-upload"
  | "after-hub-accept"
  | "after-local-publish"
  | "after-apply-journal"
  | "after-moves-staged"
  | "after-obsolete-recovery"
  | "after-moves-placed"
  | "after-directories"
  | "after-leaves";

export interface SyncFolderOptions {
  readonly fault?: (point: NormalApplyFaultPoint) => void;
}

export type CutoverFaultPoint =
  "after-cutover-journal" | "after-hub-cutover" | "after-config-projection";

export interface CutoverOptions {
  readonly fault?: (point: CutoverFaultPoint) => void;
}

export type SealFaultPoint =
  "after-outbox" | "after-upload" | "after-hub-accept" | "after-outbox-ack";

export interface SealSourceOptions {
  readonly fault?: (point: SealFaultPoint) => void;
}

export async function sealSourceV3(
  config: ProductConfig,
  options: SealSourceOptions = {},
): Promise<SyncSummary> {
  verifyConfig(config);
  assertAuthority(config);
  if (config.lifecycle !== "adoption")
    throw new Error("Source sealing is available only during adoption");
  if (config.backupWitness === null)
    throw new Error("A verified backup witness is required before source seal");
  ensureRuntimeLayout(config.root, config.stateDir);
  const ignore = ensureIgnore(config.root);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const pending = state.outbox();
  if (pending.length > 1)
    throw new Error("Source seal has multiple pending publications");
  const pendingSnapshot =
    pending.length === 0 ? null : (pending[0]?.value as SignedSnapshot);
  if (pendingSnapshot !== null) {
    if (
      pendingSnapshot.snapshot?.folderId !== config.folderId ||
      pendingSnapshot.peerId !== config.peerId
    )
      throw new Error("Pending source seal publication is invalid");
    validateNamespaceManifest(pendingSnapshot.snapshot);
  }
  let scanned = scanNamespace(
    config,
    objects,
    ignore,
    pendingSnapshot?.snapshot.entries ?? state.catalog(),
    true,
    pendingSnapshot !== null,
  );
  if (
    pendingSnapshot !== null &&
    scanned.manifest.digest !== pendingSnapshot.snapshot.digest
  )
    throw new Error("Source changed during an interrupted seal");
  await using transport = await HubTransport.connectForPeer(config);
  let checkpoint = await transport.checkpoint(config.folderId);
  assertAcceptedConfig(config, checkpoint);
  checkpoint = await resumeOutbox(state, objects, transport, checkpoint);
  if (checkpoint.snapshot !== null && pendingSnapshot === null)
    scanned = scanNamespace(
      config,
      objects,
      ignore,
      checkpoint.snapshot.entries,
      true,
      true,
    );
  if (
    checkpoint.snapshot !== null &&
    checkpoint.snapshot.digest !== scanned.manifest.digest
  )
    throw new Error("Source is already sealed at a different manifest");
  if (checkpoint.snapshot !== null) {
    state.replaceCatalog(scanned.manifest.entries, checkpoint.sequence);
    state.acceptBaseline(checkpoint.sequence, checkpoint.snapshot.digest);
    saveBaseline(config, checkpoint.snapshot);
    return summary(config, scanned, checkpoint.sequence, false, false, 0, 0);
  }
  const ids = manifestObjectIds(scanned.manifest, objects);
  const signed = signedSnapshot(
    config,
    state,
    objects,
    scanned.manifest,
    checkpoint,
  );
  const published = await publishDurably(
    state,
    objects,
    transport,
    signed,
    ids,
    options.fault,
  );
  const sequence = published.sequence;
  state.replaceCatalog(scanned.manifest.entries, sequence);
  state.acceptBaseline(sequence, scanned.manifest.digest);
  saveBaseline(config, scanned.manifest);
  return summary(config, scanned, sequence, true, false, published.uploaded, 0);
}

export async function planAdoptionV3(
  config: ProductConfig,
  options: { readonly adoptionId?: string } = {},
): Promise<AdoptionPlan> {
  verifyConfig(config);
  if (config.lifecycle !== "adoption")
    throw new Error("Adoption planning is unavailable after cutover");
  if (config.peerId === config.authority.peerId)
    throw new Error("The source authority is never an adoption target");
  ensureRuntimeLayout(config.root, config.stateDir);
  const ignore = ensureIgnore(config.root);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const target = scanNamespace(config, objects, ignore, state.catalog(), true);
  // The derived catalog is observation state, not membership configuration.
  // Persisting it makes the approval revalidation compare stable node identity.
  state.replaceCatalog(target.manifest.entries);
  await using transport = await HubTransport.connectForPeer(config);
  const checkpoint = await transport.checkpoint(config.folderId);
  assertAcceptedConfig(config, checkpoint);
  if (checkpoint.snapshot === null) throw new Error("Source is not sealed");
  assertRepositoryContexts(config, target.manifest, checkpoint.snapshot);
  const differences = classifyAdoption(checkpoint.snapshot, target.manifest);
  const summaryCounts = emptyAdoptionSummary();
  for (const difference of differences)
    summaryCounts[difference.classification] += 1;
  const adoptionId = options.adoptionId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/iu.test(adoptionId))
    throw new Error("Adoption ID is invalid");
  const path = adoptionPlanPath(config, adoptionId);
  if (existsSync(path)) {
    const existing = loadAdoptionPlan(config, adoptionId);
    if (
      existing.folderId !== config.folderId ||
      existing.targetPeerId !== config.peerId ||
      existing.sourceSequence !== checkpoint.sequence ||
      existing.sourceDigest !== checkpoint.snapshot.digest ||
      existing.targetDigest !== target.manifest.digest
    )
      throw new Error("Existing adoption plan does not match current state");
    return existing;
  }
  const plan: AdoptionPlan = {
    schemaVersion,
    adoptionId,
    folderId: config.folderId,
    sourceSequence: checkpoint.sequence,
    sourceDigest: checkpoint.snapshot.digest,
    targetPeerId: config.peerId,
    targetDigest: target.manifest.digest,
    targetSnapshot: target.manifest,
    createdAt: new Date().toISOString(),
    differences,
    summary: summaryCounts,
  };
  writeEncryptedPlan(config, path, plan);
  return plan;
}

export async function applyAdoptionV3(
  config: ProductConfig,
  adoptionId: string,
  options: AdoptionApplyOptions = {},
): Promise<SyncSummary> {
  verifyConfig(config);
  if (config.lifecycle !== "adoption")
    throw new Error("Adoption apply is unavailable after cutover");
  if (config.peerId === config.authority.peerId)
    throw new Error("Adoption apply can never mutate the source authority");
  const plan = loadAdoptionPlan(config, adoptionId);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const ignore = ensureIgnore(config.root);
  await using transport = await HubTransport.connectForPeer(config);
  const checkpoint = await transport.checkpoint(config.folderId);
  assertAcceptedConfig(config, checkpoint);
  if (
    checkpoint.snapshot === null ||
    checkpoint.sequence !== plan.sourceSequence ||
    checkpoint.snapshot.digest !== plan.sourceDigest
  )
    throw new Error("Source seal changed after adoption planning");
  const journalId = `adoption-apply:${adoptionId}`;
  const journal = state.journals().find((value) => value.id === journalId);
  const completed =
    state.getMeta(`adoption-complete:${adoptionId}`) === plan.sourceDigest;
  const target = scanNamespace(
    config,
    objects,
    ignore,
    completed ? checkpoint.snapshot.entries : plan.targetSnapshot.entries,
    true,
    completed,
  );
  if (completed) {
    if (target.manifest.digest !== checkpoint.snapshot.digest)
      throw new Error("Completed adoption no longer matches the source seal");
    await transport.recordAdoptionVerification(
      signedAdoptionVerification(
        config,
        checkpoint.sequence,
        checkpoint.snapshot.digest,
      ),
    );
    state.completeJournal(journalId);
    return summary(
      config,
      target,
      checkpoint.sequence,
      false,
      false,
      0,
      0,
      adoptionConflictCount(config, state, adoptionId),
    );
  }
  if (journal === undefined) {
    if (target.manifest.digest !== plan.targetDigest)
      throw new Error(
        "Target changed after adoption planning; create a new plan",
      );
    state.putJournal(
      journalId,
      "adoption-apply",
      {
        adoptionId,
        sourceDigest: plan.sourceDigest,
        targetDigest: plan.targetDigest,
      },
      "applying",
    );
    options.fault?.("after-apply-journal", null);
  } else {
    assertAdoptionJournal(journal.value, plan);
    assertAdoptionResumeState(target.manifest, plan, checkpoint.snapshot);
  }
  const downloadedObjects = await fetchSnapshotObjects(
    checkpoint.snapshot,
    transport,
    objects,
  );
  await preserveAdoptionDifferences(
    config,
    state,
    objects,
    target.manifest,
    checkpoint.snapshot,
    plan,
    transport,
    options,
  );
  assertAdoptionRecovery(config, objects, plan);
  options.fault?.("after-recovery-audit", null);
  const conflicts = adoptionConflictCount(config, state, adoptionId);
  await applySnapshot(
    config,
    state,
    objects,
    target.manifest,
    checkpoint.snapshot,
    "adoption",
  );
  options.fault?.("after-snapshot-apply", null);
  const verified = scanNamespace(
    config,
    objects,
    ignore,
    checkpoint.snapshot.entries,
    true,
    true,
  );
  if (verified.manifest.digest !== checkpoint.snapshot.digest)
    throw new Error("Adoption apply failed independent verification");
  state.replaceCatalog(verified.manifest.entries, checkpoint.sequence);
  state.acceptBaseline(checkpoint.sequence, checkpoint.snapshot.digest);
  saveBaseline(config, checkpoint.snapshot);
  await transport.recordAdoptionVerification(
    signedAdoptionVerification(
      config,
      checkpoint.sequence,
      checkpoint.snapshot.digest,
    ),
  );
  options.fault?.("after-hub-verification", null);
  state.setMeta(`adoption-complete:${adoptionId}`, plan.sourceDigest);
  options.fault?.("after-complete-marker", null);
  state.completeJournal(journalId);
  return summary(
    config,
    verified,
    checkpoint.sequence,
    false,
    true,
    0,
    downloadedObjects,
    conflicts,
  );
}

export async function verifyFullV3(
  config: ProductConfig,
): Promise<SyncSummary> {
  verifyConfig(config);
  ensureRuntimeLayout(config.root, config.stateDir);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const baseline = loadBaseline(config);
  let scanned = scanNamespace(
    config,
    objects,
    ensureIgnore(config.root),
    state.catalog(),
    true,
    false,
    config.syncPolicy.mode === "default-branch" && baseline !== null
      ? { accepted: baseline, baseline }
      : undefined,
  );
  try {
    await using transport = await HubTransport.connectForPeer(config);
    const checkpoint = await transport.checkpoint(config.folderId);
    assertAcceptedConfig(config, checkpoint);
    if (
      config.syncPolicy.mode === "default-branch" &&
      checkpoint.snapshot !== null
    ) {
      scanned = scanNamespace(
        config,
        objects,
        ensureIgnore(config.root),
        state.catalog(),
        true,
        false,
        { accepted: checkpoint.snapshot, baseline },
      );
    }
    const accepted =
      checkpoint.snapshot === null
        ? null
        : scanned.scope === null
          ? checkpoint.snapshot
          : projectNamespace(checkpoint.snapshot, scanned.scope);
    const reasons =
      accepted?.digest === scanned.manifest.digest
        ? []
        : ["Local semantic manifest differs from the accepted hub checkpoint"];
    for (const paused of scanned.scope?.paused ?? [])
      reasons.push(`Repository ${paused.path || "."}: ${paused.reason}`);
    const conflicts =
      state.heldOutboxCount() +
      state.heldApplyCount() +
      activeConflictCount(await transport.conflicts(config.folderId));
    return {
      ...summary(
        config,
        scanned,
        checkpoint.sequence,
        false,
        false,
        0,
        0,
        conflicts,
      ),
      status:
        reasons.length > 0
          ? "inconclusive"
          : conflicts > 0
            ? "conflict"
            : "clean",
      reasons,
    };
  } catch (error) {
    return {
      ...summary(config, scanned, state.sequence(), false, false, 0, 0),
      status: "offline",
      reasons: [message(error)],
    };
  }
}

export async function syncFolderV3(
  config: ProductConfig,
  options: SyncFolderOptions = {},
): Promise<SyncSummary> {
  verifyConfig(config);
  if (config.lifecycle !== "normal")
    throw new Error(
      "Normal synchronization is disabled until adoption cutover",
    );
  ensureRuntimeLayout(config.root, config.stateDir);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const ignore = ensureIgnore(config.root);
  let baseline = loadBaseline(config);
  let heldBaseline = baseline;
  if (config.syncPolicy.mode === "default-branch" && baseline === null)
    throw new Error(
      "Default-branch synchronization requires an adopted context baseline",
    );
  const queuedCatalog = queuedScanReferences(config, state);
  let local = scanNamespace(
    config,
    objects,
    ignore,
    queuedCatalog,
    false,
    false,
    config.syncPolicy.mode === "default-branch" && baseline !== null
      ? { accepted: baseline, baseline }
      : undefined,
  );
  let scope = local.scope;
  let published = false;
  let applied = false;
  let uploaded = 0;
  let downloaded = 0;
  const finish = (sequence: number, conflicts = 0): SyncSummary => {
    const result = summary(
      config,
      local,
      sequence,
      published,
      applied,
      uploaded,
      downloaded,
      conflicts + state.heldOutboxCount() + state.heldApplyCount(),
    );
    const retained =
      state.heldOutboxCount() + state.heldApplyCount() > 0
        ? [
            "Earlier Git-context events or interrupted applies are retained locally and were not replayed",
          ]
        : [];
    return scope !== null && scope.paused.length > 0
      ? {
          ...result,
          status: "inconclusive",
          reasons: [
            ...retained,
            ...scope.paused.map(
              (value) => `Repository ${value.path || "."}: ${value.reason}`,
            ),
          ],
        }
      : { ...result, reasons: retained };
  };
  const acceptLocal = (
    canonical: NamespaceManifest,
    sequence: number,
  ): void => {
    const accepted =
      scope === null
        ? canonical
        : combineScopedNamespace(
            projectNamespace(canonical, scope),
            heldBaseline ?? canonical,
            scope,
          );
    const catalog =
      scope === null
        ? local.manifest.entries
        : combineScopedNamespace(
            local.manifest,
            { ...(heldBaseline ?? canonical), entries: state.catalog() },
            scope,
          ).entries;
    state.replaceCatalog(catalog, sequence);
    state.acceptBaseline(sequence, canonical.digest);
    saveBaseline(config, accepted);
    baseline = accepted;
  };
  try {
    await using transport = await HubTransport.connectForPeer(config);
    let checkpoint = await transport.checkpoint(config.folderId);
    assertAcceptedConfig(config, checkpoint);
    if (checkpoint.snapshot === null)
      throw new Error("Hub has no source checkpoint");
    let workingCheckpoint = checkpoint.snapshot;
    const prepareLocal = async (): Promise<void> => {
      if (
        config.syncPolicy.mode !== "default-branch" ||
        heldBaseline === null ||
        checkpoint.snapshot === null
      )
        return;
      const prepared = await prepareGitContexts(
        config,
        heldBaseline,
        checkpoint.snapshot,
        local,
        ignore,
        objects,
      );
      baseline = prepared.baseline;
      workingCheckpoint = prepared.accepted;
      const catalog = new Map(
        [...queuedCatalog, ...state.catalog()].map((entry) => [
          entry.path,
          entry,
        ]),
      );
      for (const entry of prepared.catalog) catalog.set(entry.path, entry);
      local = scanNamespace(
        config,
        objects,
        ignore,
        [...catalog.values()],
        false,
        false,
        { accepted: workingCheckpoint, baseline },
      );
      scope = local.scope;
    };
    await prepareLocal();
    if (config.syncPolicy.mode === "default-branch") {
      const branch = config.syncPolicy.branch;
      const observed = new Map(
        local.observedRepositories.map((value) => [value.path, value]),
      );
      for (const record of state.outbox()) {
        const pending = record.value as SignedSnapshot;
        validateNamespacePolicy(pending.snapshot, config);
        const changed =
          pending.snapshot.repositories.some((previous) => {
            const current = observed.get(previous.path);
            return (
              current !== undefined &&
              current.branch === branch &&
              (current.head !== previous.head ||
                current.identity !== previous.identity)
            );
          }) ||
          local.manifest.repositories.some(
            (current) =>
              !pending.snapshot.repositories.some(
                (previous) => previous.path === current.path,
              ),
          );
        if (changed)
          state.holdOutbox(
            record.eventId,
            "Git context advanced; exact event retained without replay",
          );
      }
    }
    // A mixed-context queue is retained, not replayed into a different checkout.
    // Eligible siblings can publish a fresh CAS proposal while it stays private.
    if (scope === null || scope.paused.length === 0) {
      for (const record of state.outbox()) {
        const pending = record.value as SignedSnapshot;
        assertRepositoryContexts(config, local.manifest, pending.snapshot);
      }
      const sequence = checkpoint.sequence;
      checkpoint = await resumeOutbox(
        state,
        objects,
        transport,
        checkpoint,
        (pending) =>
          assertRepositoryContexts(
            config,
            local.manifest,
            pending.snapshot,
            scope,
          ),
      );
      if (sequence !== checkpoint.sequence) {
        if (checkpoint.snapshot === null)
          throw new Error("Resumed checkpoint is missing");
        workingCheckpoint = checkpoint.snapshot;
        await prepareLocal();
      }
    }
    importPublishedConflicts(
      state,
      await transport.conflicts(config.folderId),
      config.peerId,
    );
    if (
      await resumePendingSnapshotApply(
        config,
        state,
        objects,
        transport,
        checkpoint,
        local.manifest,
        options,
      )
    ) {
      applied = true;
      baseline = loadBaseline(config);
      heldBaseline = baseline;
      local = scanNamespace(
        config,
        objects,
        ignore,
        state.catalog(),
        true,
        false,
        scope === null
          ? undefined
          : { accepted: checkpoint.snapshot!, baseline, scope },
      );
      workingCheckpoint = checkpoint.snapshot!;
      await prepareLocal();
    }
    if (checkpoint.snapshot === null)
      throw new Error("Hub has no source checkpoint");
    let remote =
      scope === null
        ? workingCheckpoint
        : projectNamespace(workingCheckpoint, scope);
    assertRepositoryContexts(config, local.manifest, remote, scope);
    const transitionPending =
      workingCheckpoint.digest !== checkpoint.snapshot.digest;
    if (local.manifest.digest === remote.digest && !transitionPending) {
      acceptLocal(checkpoint.snapshot, checkpoint.sequence);
      return finish(
        checkpoint.sequence,
        activeConflictCount(await transport.conflicts(config.folderId)),
      );
    }
    const base =
      baseline === null
        ? null
        : scope === null
          ? baseline
          : projectNamespace(baseline, scope);
    downloaded += await fetchSnapshotObjects(remote, transport, objects);
    let desired = local.manifest;
    let conflicts: ConflictRecord[] = [];
    if (base !== null && local.manifest.digest === base.digest)
      desired = remote;
    else if (base !== null && remote.digest !== base.digest) {
      const merged = mergeSnapshots(
        config,
        base,
        local.manifest,
        remote,
        objects,
      );
      desired = merged.manifest;
      conflicts = merged.conflicts;
    }
    desired = reattachRestoredNodes(desired, remote, state);
    assertRepositoryContexts(config, local.manifest, desired, scope);
    if (
      desired.digest !== remote.digest ||
      conflicts.length > 0 ||
      transitionPending
    ) {
      const proposal =
        scope === null
          ? desired
          : combineScopedNamespace(desired, checkpoint.snapshot, scope);
      const required = new Set(manifestObjectIds(desired, objects));
      if (transitionPending)
        downloaded += await fetchSnapshotObjects(
          scope === null
            ? checkpoint.snapshot
            : projectNamespace(checkpoint.snapshot, scope),
          transport,
          objects,
          false,
        );
      for (const conflict of conflicts)
        if (conflict.manifestId !== null)
          for (const id of referencedObjects(conflict.manifestId, objects))
            required.add(id);
      const accepted = await publishDurably(
        state,
        objects,
        transport,
        signedSnapshot(config, state, objects, proposal, checkpoint, conflicts),
        [...required],
        (point) => {
          if (
            point === "after-outbox" ||
            point === "after-upload" ||
            point === "after-hub-accept"
          )
            options.fault?.(point);
        },
        () => assertRepositoryContexts(config, local.manifest, desired, scope),
      );
      published = true;
      uploaded = accepted.uploaded;
      for (const conflict of conflicts) state.addConflict(conflict);
      checkpoint = await transport.checkpoint(config.folderId);
      if (
        checkpoint.sequence !== accepted.sequence ||
        checkpoint.snapshot === null
      )
        throw new Error("Accepted snapshot is unavailable");
      remote =
        scope === null
          ? checkpoint.snapshot
          : projectNamespace(checkpoint.snapshot, scope);
    }
    let journalId: string | null = null;
    if (remote.digest !== local.manifest.digest) {
      downloaded += await fetchSnapshotObjects(remote, transport, objects);
      journalId = await applySnapshot(
        config,
        state,
        objects,
        local.manifest,
        remote,
        "normal",
        checkpoint.sequence,
        options,
        scope,
        checkpoint.snapshot.digest,
      );
      applied = true;
    } else if (published) options.fault?.("after-local-publish");
    local = scanNamespace(
      config,
      objects,
      ignore,
      remote.entries,
      true,
      true,
      scope === null
        ? undefined
        : { accepted: checkpoint.snapshot, baseline, scope },
    );
    if (published && !applied && local.manifest.digest !== remote.digest) {
      acceptLocal(checkpoint.snapshot, checkpoint.sequence);
      return {
        ...finish(
          checkpoint.sequence,
          activeConflictCount(await transport.conflicts(config.folderId)),
        ),
        status: "inconclusive",
        reasons: [
          "Local namespace changed while its checkpoint was publishing; retry will publish the newer state",
        ],
      };
    }
    assertDigest(local.manifest, remote);
    acceptLocal(checkpoint.snapshot, checkpoint.sequence);
    if (journalId !== null) state.completeJournal(journalId);
    return finish(
      checkpoint.sequence,
      activeConflictCount(await transport.conflicts(config.folderId)),
    );
  } catch (error) {
    return {
      ...finish(state.sequence()),
      status: "inconclusive",
      reasons: [
        ...(scope?.paused.map(
          (value) => `Repository ${value.path || "."}: ${value.reason}`,
        ) ?? []),
        message(error),
      ],
    };
  }
}

export async function cutoverAdoptionV3(
  config: ProductConfig,
  configPath: string,
  options: CutoverOptions = {},
): Promise<ProductConfig> {
  verifyConfig(config);
  assertAuthority(config);
  if (config.lifecycle !== "adoption")
    throw new Error("Folder is already in normal mode");
  ensureRuntimeLayout(config.root, config.stateDir);
  using state = new LocalState(config);
  recoverInterruptedApplies(config, state);
  const updated = reviseConfig(
    config,
    { lifecycle: "normal" },
    authorityPrivateKey(config),
  );
  const journalId = `cutover:${updated.revision}`;
  const journalValue = {
    configPath: resolve(configPath),
    expectedRevision: config.revision,
    updated,
  };
  const existingJournal = state
    .journals()
    .find((journal) => journal.id === journalId);
  if (
    existingJournal !== undefined &&
    canonicalJson(existingJournal.value) !== canonicalJson(journalValue)
  )
    throw new Error("Cutover journal does not match the requested transition");
  await using transport = await HubTransport.connectForPeer(config);
  const checkpoint = await transport.checkpoint(config.folderId);
  if (
    checkpoint.config.lifecycle === "normal" &&
    checkpoint.config.revision === updated.revision &&
    canonicalJson(checkpoint.config) === canonicalJson(updated)
  ) {
    saveConfig(configPath, updated, false);
    state.completeJournal(journalId);
    return updated;
  }
  assertAcceptedConfig(config, checkpoint);
  if (checkpoint.snapshot === null) throw new Error("Source is not sealed");
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const source = scanNamespace(
    config,
    objects,
    ensureIgnore(config.root),
    checkpoint.snapshot.entries,
    true,
  );
  if (source.manifest.digest !== checkpoint.snapshot.digest)
    throw new Error("Source changed after sealing; cutover is blocked");
  const verified = new Set(
    await transport.verifiedAdoptionPeers(config.folderId),
  );
  const required = config.peers
    .filter(
      (peer) => peer.peerId !== config.authority.peerId && peer.role !== "hub",
    )
    .map((peer) => peer.peerId);
  const missing = required.filter((peerId) => !verified.has(peerId));
  if (missing.length > 0)
    throw new Error(`Adoption targets are not verified: ${missing.join(", ")}`);
  if (existingJournal === undefined) {
    state.putJournal(journalId, "cutover", journalValue);
    options.fault?.("after-cutover-journal");
  }
  await transport.updateConfig(updated, config.revision);
  options.fault?.("after-hub-cutover");
  saveConfig(configPath, updated, false);
  options.fault?.("after-config-projection");
  state.completeJournal(journalId);
  return updated;
}

export async function statusV3(config: ProductConfig): Promise<{
  readonly peerId: string;
  readonly authorityPeerId: string;
  readonly lifecycle: string;
  readonly configRevision: number;
  readonly acceptedConfigRevision: number | null;
  readonly hubReachable: boolean;
  readonly hubError: string | null;
  readonly hubSequence: number | null;
  readonly localCursor: number;
  readonly outboxEntries: number;
  readonly heldOutboxEntries: number;
  readonly heldApplyEntries: number;
  readonly pendingJournals: number;
  readonly catalogEntries: number;
  readonly catalogHistoryEntries: number;
  readonly retainedTombstones: number;
  readonly repositoryContexts: number;
  readonly recoveryEntries: number;
  readonly conflicts: readonly ConflictRecord[];
  readonly verifiedAdoptionPeers: readonly string[];
}> {
  verifyConfig(config);
  using state = new LocalState(config);
  const conflicts = new Map(
    state.conflicts().map((conflict) => [conflict.conflictId, conflict]),
  );
  const catalogHistory = state.catalogHistory();
  const baseline = loadBaseline(config);
  const local = {
    peerId: config.peerId,
    authorityPeerId: config.authority.peerId,
    lifecycle: config.lifecycle,
    configRevision: config.revision,
    localCursor: state.sequence(),
    outboxEntries: state.outbox().length,
    heldOutboxEntries: state.heldOutboxCount(),
    heldApplyEntries: state.heldApplyCount(),
    pendingJournals: state.journals().length,
    catalogEntries: state.catalog().length,
    catalogHistoryEntries: catalogHistory.length,
    retainedTombstones: catalogHistory.filter((entry) => entry.tombstone)
      .length,
    repositoryContexts: baseline?.repositories.length ?? 0,
    recoveryEntries: state
      .conflicts()
      .filter((conflict) => conflict.recoveryPath.length > 0).length,
    conflicts: [...conflicts.values()],
  };
  try {
    await using transport = await HubTransport.connectForPeer(config);
    const checkpoint = await transport.checkpoint(config.folderId);
    assertAcceptedConfig(config, checkpoint);
    for (const conflict of await transport.conflicts(config.folderId))
      conflicts.set(conflict.conflictId, conflict);
    for (const conflict of state.conflicts())
      conflicts.set(conflict.conflictId, conflict);
    return {
      ...local,
      acceptedConfigRevision: checkpoint.config.revision,
      hubReachable: true,
      hubError: null,
      hubSequence: checkpoint.sequence,
      repositoryContexts:
        checkpoint.snapshot?.repositories.length ?? local.repositoryContexts,
      conflicts: [...conflicts.values()],
      verifiedAdoptionPeers: await transport.verifiedAdoptionPeers(
        config.folderId,
      ),
    };
  } catch (error) {
    return {
      ...local,
      acceptedConfigRevision: null,
      hubReachable: false,
      hubError: message(error),
      hubSequence: null,
      verifiedAdoptionPeers: [],
    };
  }
}

export async function historyV3(
  config: ProductConfig,
): Promise<readonly Record<string, unknown>[]> {
  await using transport = await HubTransport.connectForPeer(config);
  return transport.history(config.folderId);
}

export async function hasRemoteChangesV3(
  config: ProductConfig,
): Promise<boolean> {
  verifyConfig(config);
  using state = new LocalState(config);
  await using transport = await HubTransport.connectForPeer(config);
  const checkpoint = await transport.checkpoint(config.folderId);
  assertAcceptedConfig(config, checkpoint);
  return checkpoint.sequence !== state.sequence();
}

export async function previewIgnoreRevisionV3(
  config: ProductConfig,
  previousSource: string,
): Promise<{
  readonly previousDigest: string;
  readonly nextDigest: string;
  readonly newlyIncluded: { readonly count: number; readonly bytes: number };
  readonly newlyExcluded: { readonly count: number; readonly bytes: number };
}> {
  verifyConfig(config);
  assertAuthority(config);
  const previous = compileIgnore(previousSource);
  if (previous.digest !== config.ignoreDigest)
    throw new Error(
      "Previous ignore source does not match the accepted digest",
    );
  const next = ensureIgnore(config.root);
  using state = new LocalState(config);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const before = scanNamespace(
    config,
    objects,
    previous,
    state.catalog(),
    true,
  );
  const nextConfig = { ...config, ignoreDigest: next.digest };
  const after = scanNamespace(
    nextConfig,
    objects,
    next,
    before.manifest.entries,
    true,
  );
  const beforePaths = new Map(
    before.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const afterPaths = new Map(
    after.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const newlyIncluded = after.manifest.entries.filter(
    (entry) => !beforePaths.has(entry.path),
  );
  const newlyExcluded = before.manifest.entries.filter(
    (entry) => !afterPaths.has(entry.path),
  );
  return {
    previousDigest: previous.digest,
    nextDigest: next.digest,
    newlyIncluded: {
      count: newlyIncluded.length,
      bytes: newlyIncluded.reduce((total, entry) => total + entry.size, 0),
    },
    newlyExcluded: {
      count: newlyExcluded.length,
      bytes: newlyExcluded.reduce((total, entry) => total + entry.size, 0),
    },
  };
}

export async function acceptIgnoreRevisionV3(
  config: ProductConfig,
  configPath: string,
  previousSource: string,
): Promise<ProductConfig> {
  const preview = await previewIgnoreRevisionV3(config, previousSource);
  if (preview.nextDigest === preview.previousDigest) return config;
  const updated = reviseConfig(
    config,
    { ignoreDigest: preview.nextDigest },
    authorityPrivateKey(config),
  );
  await using transport = await HubTransport.connectForPeer(config);
  await transport.updateConfig(updated, config.revision);
  saveConfig(configPath, updated, false);
  using state = new LocalState(updated);
  using objects = new ObjectStore(join(updated.stateDir, "objects"));
  let scanned = scanNamespace(
    updated,
    objects,
    ensureIgnore(updated.root),
    state.catalog(),
    true,
  );
  const checkpoint = await transport.checkpoint(updated.folderId);
  scanned = {
    ...scanned,
    manifest: reattachRestoredNodes(
      scanned.manifest,
      checkpoint.snapshot,
      state,
    ),
  };
  const objectIds = manifestObjectIds(scanned.manifest, objects);
  const published = await publishDurably(
    state,
    objects,
    transport,
    signedSnapshot(updated, state, objects, scanned.manifest, checkpoint),
    objectIds,
  );
  state.replaceCatalog(scanned.manifest.entries, published.sequence);
  state.acceptBaseline(published.sequence, scanned.manifest.digest);
  saveBaseline(updated, scanned.manifest);
  return updated;
}

export function recoverConflictV3(
  config: ProductConfig,
  conflictId: string,
  destination: string,
): void {
  using state = new LocalState(config);
  const conflict = state
    .conflicts()
    .find((value) => value.conflictId === conflictId);
  if (conflict === undefined)
    throw new Error(`Unknown conflict: ${conflictId}`);
  const target = resolve(destination);
  if (pathExists(target))
    throw new Error("Recovery destination must be absent");
  const source = conflict.recoveryPath
    ? isAbsolute(conflict.recoveryPath)
      ? resolve(conflict.recoveryPath)
      : safeTarget(config.root, conflict.recoveryPath)
    : null;
  if (source !== null && pathExists(source)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, {
      recursive: lstatSync(source).isDirectory(),
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    return;
  }
  if (conflict.manifestId === null)
    throw new Error("Conflict has no recoverable content manifest");
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  materializeManifest(conflict.manifestId, target, objects);
}

/** Recover a retained event or apply leaf privately, never into a checkout. */
export function recoverHeldFileV3(
  config: ProductConfig,
  eventId: string,
  path: string,
  before = false,
): string {
  verifyConfig(config);
  normalizeRelativePath(path);
  using state = new LocalState(config);
  const held = state.heldEvent(eventId);
  let snapshot: NamespaceManifest;
  if (typeof held === "object" && held !== null) {
    if (before) throw new Error("A queued event has no pre-apply version");
    const event = held as SignedSnapshot;
    validateNamespaceManifest(event.snapshot);
    const peer = config.peers.find((value) => value.peerId === event.peerId);
    if (
      event.eventId !== eventId ||
      event.snapshot.folderId !== config.folderId ||
      peer === undefined ||
      !verifyPayload(snapshotPayload(event), event.signature, peer.publicKey)
    )
      throw new Error("Held event signature or folder does not match");
    snapshot = event.snapshot;
  } else {
    const record = state
      .journals()
      .find(
        (value) => value.id === eventId && value.kind === "held-snapshot-apply",
      );
    if (record === undefined)
      throw new Error("Held recovery record is unavailable");
    const journal = snapshotApplyJournal(record.value);
    if (journal.folderId !== config.folderId)
      throw new Error("Held apply belongs to another folder");
    snapshot = before ? journal.current : journal.desired;
    validateNamespacePolicy(snapshot, config);
  }
  const entry = snapshot.entries.find((entry) => entry.path === path);
  if (
    entry === undefined ||
    entry.kind === "directory" ||
    entry.manifestId === null
  )
    throw new Error("Held event has no recoverable leaf at that path");
  const target = safeTarget(
    config.stateDir,
    `held-recovery/${hashText(eventId)}/${before ? "before" : "accepted"}/${path}`,
  );
  if (pathExists(target))
    throw new Error("Held recovery destination must be absent");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  materializeManifest(entry.manifestId, target, objects);
  if (entry.kind === "regular" && isPlaintextEnvPath(path))
    chmodSync(target, 0o600);
  return target;
}

export function promoteConflictV3(
  config: ProductConfig,
  conflictId: string,
  requestedPath?: string,
): string {
  verifyConfig(config);
  if (config.lifecycle !== "normal")
    throw new Error("Conflict promotion is available only after cutover");
  using state = new LocalState(config);
  const conflict = state
    .conflicts()
    .find((value) => value.conflictId === conflictId);
  if (conflict === undefined)
    throw new Error(`Unknown conflict: ${conflictId}`);
  const relativePath =
    requestedPath ??
    conflictPath(conflict.originalPath, config.peerName, conflict.conflictId);
  const destination = safeTarget(config.root, relativePath);
  recoverConflictV3(config, conflictId, destination);
  return relative(config.root, destination).replaceAll(sep, "/");
}

function signedSnapshot(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  snapshot: NamespaceManifest,
  checkpoint: HubCheckpoint,
  conflicts: readonly ConflictRecord[] = [],
): SignedSnapshot {
  const eventId = randomUUID();
  const peerSequence = state.nextPeerSequence();
  const unsigned: SignedSnapshot = {
    snapshot,
    peerId: config.peerId,
    baseSequence: checkpoint.sequence,
    eventId,
    peerSequence,
    mutations: deriveMutations({
      config,
      eventId,
      peerSequence,
      base: checkpoint.snapshot,
      next: snapshot,
      objects,
      restoredNodeIds: state.tombstonedNodeIds(),
    }),
    conflicts,
    signature: "",
  };
  return {
    ...unsigned,
    signature: signPayload(snapshotPayload(unsigned), peerPrivateKey(config)),
  };
}

function reattachRestoredNodes(
  snapshot: NamespaceManifest,
  baseline: NamespaceManifest | null,
  state: LocalState,
): NamespaceManifest {
  const active = new Set(
    (baseline?.entries ?? []).map((entry) => entry.nodeId),
  );
  const candidates = state
    .catalogHistory()
    .filter((entry) => entry.tombstone)
    .sort((left, right) => right.sequence - left.sequence);
  const claimed = new Set<string>();
  let changed = false;
  const restoredEntries = snapshot.entries.map((entry) => {
    if (active.has(entry.nodeId)) return entry;
    const retained = candidates.find(
      (candidate) =>
        !claimed.has(candidate.nodeId) &&
        candidate.entry.path === entry.path &&
        candidate.contentVersion === contentVersion(entry),
    );
    if (retained === undefined || retained.nodeId === entry.nodeId)
      return entry;
    claimed.add(retained.nodeId);
    changed = true;
    return { ...entry, nodeId: retained.nodeId };
  });
  if (!changed) return snapshot;
  const entries = assignParentNodeIds(restoredEntries);
  return {
    ...snapshot,
    entries,
    digest: semanticDigest(
      entries,
      snapshot.ignoreDigest,
      snapshot.repositories,
    ),
  };
}

function importPublishedConflicts(
  state: LocalState,
  conflicts: readonly ConflictRecord[],
  peerId: string,
): void {
  for (const conflict of conflicts)
    if (conflict.peerId === peerId) state.addConflict(conflict);
}

function signedConflict(
  config: ProductConfig,
  conflict: ConflictRecord,
): SignedConflict {
  const unsigned: SignedConflict = {
    folderId: config.folderId,
    peerId: config.peerId,
    eventId: `conflict:${conflict.conflictId}`,
    conflict,
    signature: "",
  };
  return {
    ...unsigned,
    signature: signPayload(conflictPayload(unsigned), peerPrivateKey(config)),
  };
}

function signedAdoptionVerification(
  config: ProductConfig,
  sourceSequence: number,
  sourceDigest: string,
): SignedAdoptionVerification {
  const unsigned: SignedAdoptionVerification = {
    folderId: config.folderId,
    peerId: config.peerId,
    eventId: `adoption-verification:${config.peerId}:${sourceSequence}:${sourceDigest}`,
    sourceSequence,
    sourceDigest,
    signature: "",
  };
  return {
    ...unsigned,
    signature: signPayload(
      adoptionVerificationPayload(unsigned),
      peerPrivateKey(config),
    ),
  };
}

async function publishDurably(
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  snapshot: SignedSnapshot,
  objectIds: readonly string[],
  fault?: (point: SealFaultPoint) => void,
  beforeAccept?: () => void,
): Promise<{ readonly sequence: number; readonly uploaded: number }> {
  state.queueOutbox(snapshot.eventId, snapshot, objectIds);
  fault?.("after-outbox");
  const uploaded = await transport.ensureHubObjects(objectIds, objects);
  fault?.("after-upload");
  beforeAccept?.();
  const sequence = await transport.acceptSnapshot(snapshot);
  fault?.("after-hub-accept");
  state.acknowledgeOutbox(snapshot.eventId);
  fault?.("after-outbox-ack");
  return { sequence, uploaded };
}

async function resumeOutbox(
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  initial: HubCheckpoint,
  beforeAccept?: (snapshot: SignedSnapshot) => void,
): Promise<HubCheckpoint> {
  let checkpoint = initial;
  for (const record of state.outbox()) {
    const snapshot = record.value as SignedSnapshot;
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      snapshot.eventId !== record.eventId ||
      snapshot.snapshot?.folderId !== checkpoint.config.folderId
    )
      throw new Error(`Durable outbox entry is invalid: ${record.eventId}`);
    try {
      await transport.ensureHubObjects(record.objectIds, objects);
      beforeAccept?.(snapshot);
      await transport.acceptSnapshot(snapshot);
      state.acknowledgeOutbox(record.eventId);
      checkpoint = await transport.checkpoint(checkpoint.config.folderId);
    } catch (error) {
      if (!message(error).includes("compare-and-swap")) throw error;
      const history = await transport.history(checkpoint.config.folderId);
      if (history.some((entry) => entry.event_id === record.eventId)) {
        state.acknowledgeOutbox(record.eventId);
        checkpoint = await transport.checkpoint(checkpoint.config.folderId);
        continue;
      }
      // The live tree still contains the stable proposal. Remove only the stale
      // serialization so this scan can causally merge and queue a new event.
      state.acknowledgeOutbox(record.eventId);
    }
  }
  return checkpoint;
}

/** A crashed publisher's new node identities are durable in its signed outbox. */
function queuedScanReferences(
  config: ProductConfig,
  state: LocalState,
): readonly CatalogEntry[] {
  const catalog = state.catalog();
  const queued = state.outbox();
  if (queued.length === 0) return catalog;
  const localPeer = config.peers.find((peer) => peer.peerId === config.peerId);
  if (localPeer === undefined)
    throw new Error("Queued publisher is not enrolled");
  const references = new Map(catalog.map((entry) => [entry.nodeId, entry]));
  for (const record of queued) {
    const pending = record.value as SignedSnapshot;
    if (
      pending.peerId !== config.peerId ||
      pending.eventId !== record.eventId ||
      pending.snapshot?.folderId !== config.folderId ||
      !verifyPayload(
        snapshotPayload(pending),
        pending.signature,
        localPeer.publicKey,
      )
    )
      throw new Error("Queued scan reference is not the local signed proposal");
    validateNamespacePolicy(pending.snapshot, config);
    for (const entry of pending.snapshot.entries)
      if (!references.has(entry.nodeId)) references.set(entry.nodeId, entry);
  }
  return [...references.values()];
}

async function fetchSnapshotObjects(
  snapshot: NamespaceManifest,
  transport: HubTransport,
  objects: ObjectStore,
  includeChunks = true,
): Promise<number> {
  const pending = [
    ...snapshot.entries.flatMap((entry) =>
      entry.manifestId === null ? [] : [entry.manifestId],
    ),
  ];
  const visited = new Set<string>();
  let downloaded = 0;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    downloaded += await transport.fetchObjects([id], objects);
    const manifest = parseManifest(objects.get(id));
    if (manifest.type === "regular" && includeChunks) {
      const chunks = manifest.chunks.map((chunk) => chunk.id);
      downloaded += await transport.fetchObjects(chunks, objects);
      for (const chunk of chunks) visited.add(chunk);
    } else if (manifest.type === "tree") {
      for (const entry of manifest.entries)
        if (entry.manifestId !== null) pending.push(entry.manifestId);
    }
  }
  return downloaded;
}

function classifyAdoption(
  source: NamespaceManifest,
  target: NamespaceManifest,
): readonly AdoptionDifference[] {
  const sourceByPath = new Map(
    source.entries.map((entry) => [entry.path, entry]),
  );
  const targetByPath = new Map(
    target.entries.map((entry) => [entry.path, entry]),
  );
  const unmatchedTarget = new Set(
    target.entries
      .filter((entry) => !sourceByPath.has(entry.path))
      .map((entry) => entry.path),
  );
  const byContent = new Map<string, CatalogEntry[]>();
  for (const entry of target.entries) {
    if (!unmatchedTarget.has(entry.path) || entry.kind === "directory")
      continue;
    const key = contentKey(entry);
    const values = byContent.get(key) ?? [];
    values.push(entry);
    byContent.set(key, values);
  }
  const claimedMoved = new Set<string>();
  const differences: AdoptionDifference[] = [];
  for (const sourceEntry of source.entries) {
    const targetEntry = targetByPath.get(sourceEntry.path);
    if (targetEntry !== undefined) {
      const classification: AdoptionClassification =
        sourceEntry.kind !== targetEntry.kind
          ? "type-conflicting"
          : sameContent(sourceEntry, targetEntry)
            ? "exact"
            : "divergent";
      differences.push({
        path: sourceEntry.path,
        classification,
        sourcePath: sourceEntry.path,
        targetPath: targetEntry.path,
        bytes: Math.max(sourceEntry.size, targetEntry.size),
      });
      continue;
    }
    const matches = byContent
      .get(contentKey(sourceEntry))
      ?.filter((entry) => !claimedMoved.has(entry.path));
    if (sourceEntry.kind !== "directory" && matches?.length === 1) {
      const match = matches[0];
      if (match !== undefined) {
        claimedMoved.add(match.path);
        differences.push({
          path: sourceEntry.path,
          classification: "moved-equivalent",
          sourcePath: sourceEntry.path,
          targetPath: match.path,
          bytes: sourceEntry.size,
        });
        continue;
      }
    }
    differences.push({
      path: sourceEntry.path,
      classification: "source-only",
      sourcePath: sourceEntry.path,
      targetPath: null,
      bytes: sourceEntry.size,
    });
  }
  for (const targetEntry of target.entries) {
    if (
      sourceByPath.has(targetEntry.path) ||
      claimedMoved.has(targetEntry.path)
    )
      continue;
    differences.push({
      path: targetEntry.path,
      classification: "target-only",
      sourcePath: null,
      targetPath: targetEntry.path,
      bytes: targetEntry.size,
    });
  }
  return differences.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

async function preserveAdoptionDifferences(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  target: NamespaceManifest,
  source: NamespaceManifest,
  plan: AdoptionPlan,
  transport: HubTransport,
  options: AdoptionApplyOptions,
): Promise<void> {
  const targetByPath = new Map(
    plan.targetSnapshot.entries.map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    target.entries.map((entry) => [entry.path, entry]),
  );
  const sourceByPath = new Map(
    source.entries.map((entry) => [entry.path, entry]),
  );
  const moved = plan.differences.filter(
    (difference) => difference.classification === "moved-equivalent",
  );
  const moveStagingRoot = join(
    config.stateDir,
    "adoption-moves",
    plan.adoptionId,
  );
  for (const difference of moved) {
    if (difference.targetPath === null || difference.sourcePath === null)
      continue;
    const from = safeTarget(config.root, difference.targetPath);
    const to = safeTarget(config.root, difference.sourcePath);
    const staged = join(
      moveStagingRoot,
      hashText(`${difference.targetPath}\0${difference.sourcePath}`),
    );
    if (pathExists(from) && (pathExists(staged) || pathExists(to)))
      throw new Error(
        `Moved-equivalent source and target both exist: ${difference.path}`,
      );
    if (pathExists(from)) {
      mkdirSync(moveStagingRoot, { recursive: true, mode: 0o700 });
      renameWithJournal(state, from, staged);
    }
    if (!pathExists(staged) && !pathExists(to))
      throw new Error(
        `Moved-equivalent content is missing: ${difference.path}`,
      );
  }
  const top = adoptionRecoveryCandidates(plan);
  for (const difference of [...top].sort(
    (left, right) => depth(right.path) - depth(left.path),
  )) {
    const live = safeTarget(config.root, difference.path);
    const recovery = safeRecoveryTarget(
      join(config.stateDir, "adoption-recovery", plan.adoptionId),
      difference.path,
    );
    const entry = targetByPath.get(difference.path);
    const conflictId = `adoption:${plan.adoptionId}:${hashText(difference.path).slice(0, 16)}`;
    const existingConflict = state
      .conflicts()
      .find((value) => value.conflictId === conflictId);
    const evidencePath = pathExists(recovery) ? recovery : live;
    const manifestId =
      existingConflict?.manifestId ??
      (entry?.kind === "directory"
        ? captureSnapshotSubtree(entry, plan.targetSnapshot, objects)
        : (entry?.manifestId ?? null));
    const conflict: ConflictRecord = {
      conflictId,
      kind: "adoption",
      peerId: config.peerId,
      originalPath: difference.path,
      recoveryPath: recovery,
      manifestId,
      reason: difference.classification,
      createdAt: new Date().toISOString(),
    };
    const liveIsSource = sameContentOptional(
      currentByPath.get(difference.path),
      sourceByPath.get(difference.path),
    );
    if (pathExists(live) && pathExists(recovery) && !liveIsSource)
      throw new Error(
        `Adoption recovery and unverified live target both exist: ${difference.path}`,
      );
    if (pathExists(live) && !pathExists(recovery)) {
      if (liveIsSource)
        throw new Error(
          `Adoption target evidence is missing after canonical apply: ${difference.path}`,
        );
      moveScopedWithJournal(
        config,
        state,
        live,
        recovery,
        "adoption-recovery",
        plan.targetSnapshot,
      );
      options.fault?.("after-recovery-move", difference.path);
    }
    if (!pathExists(recovery))
      throw new Error(
        `Adoption recovery object is missing: ${difference.path}`,
      );
    const acceptedConflict = existingConflict ?? conflict;
    if (
      acceptedConflict.originalPath !== conflict.originalPath ||
      acceptedConflict.recoveryPath !== conflict.recoveryPath ||
      acceptedConflict.manifestId !== conflict.manifestId ||
      acceptedConflict.reason !== conflict.reason
    )
      throw new Error(`Adoption conflict evidence changed: ${difference.path}`);
    state.addConflict(acceptedConflict);
    options.fault?.("after-local-conflict", difference.path);
    const sanitized: ConflictRecord = {
      ...acceptedConflict,
      originalPath: `sha256:${hashText(acceptedConflict.originalPath)}`,
      recoveryPath: "local-only",
    };
    await transport.addConflict(signedConflict(config, sanitized));
    options.fault?.("after-hub-conflict", difference.path);
  }
  for (const difference of moved) {
    if (difference.targetPath === null || difference.sourcePath === null)
      continue;
    const to = safeTarget(config.root, difference.sourcePath);
    const staged = join(
      moveStagingRoot,
      hashText(`${difference.targetPath}\0${difference.sourcePath}`),
    );
    if (pathExists(staged) && pathExists(to))
      throw new Error(
        `Moved-equivalent source and target both exist: ${difference.path}`,
      );
    if (pathExists(staged)) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameWithJournal(state, staged, to);
    }
    if (!pathExists(to))
      throw new Error(
        `Moved-equivalent content is missing: ${difference.path}`,
      );
  }
  if (pathExists(moveStagingRoot)) rmdirSync(moveStagingRoot);
}

function adoptionRecoveryCandidates(
  plan: AdoptionPlan,
): readonly AdoptionDifference[] {
  const candidates = plan.differences.filter((difference) =>
    ["target-only", "divergent", "type-conflicting"].includes(
      difference.classification,
    ),
  );
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate && candidate.path.startsWith(`${other.path}/`),
      ),
  );
}

function assertAdoptionJournal(value: unknown, plan: AdoptionPlan): void {
  if (typeof value !== "object" || value === null)
    throw new Error("Adoption apply journal is invalid");
  const record = value as Record<string, unknown>;
  if (
    record.adoptionId !== plan.adoptionId ||
    record.sourceDigest !== plan.sourceDigest ||
    record.targetDigest !== plan.targetDigest
  )
    throw new Error("Adoption apply journal does not match the approved plan");
}

function assertAdoptionResumeState(
  current: NamespaceManifest,
  plan: AdoptionPlan,
  source: NamespaceManifest,
): void {
  const plannedByPath = new Map(
    plan.targetSnapshot.entries.map((entry) => [entry.path, entry]),
  );
  const sourceByPath = new Map(
    source.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of current.entries) {
    if (
      !sameContentOptional(entry, plannedByPath.get(entry.path)) &&
      !sameContentOptional(entry, sourceByPath.get(entry.path))
    )
      throw new Error(
        `Target changed outside the resumable adoption transaction: ${entry.path}`,
      );
  }
}

function assertAdoptionRecovery(
  config: ProductConfig,
  objects: ObjectStore,
  plan: AdoptionPlan,
): void {
  const candidates = adoptionRecoveryCandidates(plan);
  if (candidates.length === 0) return;
  const recoveryRoot = join(
    config.stateDir,
    "adoption-recovery",
    plan.adoptionId,
  );
  if (!existsSync(recoveryRoot))
    throw new Error("Adoption recovery root is missing");
  const recoveryIgnore = compileIgnore(defaultIgnore);
  const recovered = scanNamespace(
    { ...config, root: recoveryRoot, ignoreDigest: recoveryIgnore.digest },
    objects,
    recoveryIgnore,
    plan.targetSnapshot.entries,
    true,
  ).manifest;
  const included = (path: string) =>
    candidates.some(
      (candidate) =>
        path === candidate.path || path.startsWith(`${candidate.path}/`),
    );
  const movedTargets = new Set(
    plan.differences.flatMap((difference) =>
      difference.classification === "moved-equivalent" &&
      difference.targetPath !== null
        ? [difference.targetPath]
        : [],
    ),
  );
  const expectedEntries = new Map(
    plan.targetSnapshot.entries
      .filter((entry) => included(entry.path) && !movedTargets.has(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  const recoveredEntries = new Map(
    recovered.entries.map((entry) => [entry.path, entry]),
  );
  for (const [path, expected] of expectedEntries) {
    if (!sameContentOptional(recoveredEntries.get(path), expected))
      throw new Error(`Adoption recovery content mismatch: ${path}`);
  }
  for (const entry of recovered.entries) {
    if (expectedEntries.has(entry.path)) continue;
    if (
      entry.kind === "directory" &&
      [...expectedEntries.keys()].some((path) =>
        path.startsWith(`${entry.path}/`),
      )
    )
      continue;
    throw new Error(
      `Adoption recovery has unreferenced content: ${entry.path}`,
    );
  }
}

interface SnapshotApplyJournal {
  readonly folderId: string;
  readonly acceptedSequence: number;
  readonly current: NamespaceManifest;
  readonly desired: NamespaceManifest;
  readonly recoveryRoot: string;
  readonly moveStageRoot: string;
  readonly scope: RepositoryScope | null;
  readonly acceptedDigest: string;
}

interface ApplyMoveIntent {
  readonly applyId: string;
  readonly paths: readonly string[];
}

function applyScopeSubset(
  scope: RepositoryScope,
  active: readonly RepositoryContext[],
  reason: string,
): RepositoryScope {
  const included = new Set(active.map((context) => context.path));
  const previous = new Map(
    scope.paused.map((value) => [value.path, value.reason]),
  );
  return {
    paths: scope.paths,
    active,
    guards: scope.guards.filter((guard) =>
      active.some(
        (context) =>
          context.path !== guard.path &&
          (guard.path === "" || context.path.startsWith(`${guard.path}/`)),
      ),
    ),
    paused: scope.paths
      .filter((path) => !included.has(path))
      .map((path) => ({
        path,
        reason: previous.get(path) ?? reason,
      })),
  };
}

/** Unknown Git state waits; proved context changes retain intent without replay. */
function resumableApplyScope(
  config: ProductConfig,
  journal: SnapshotApplyJournal,
  accepted?: NamespaceManifest,
): {
  readonly scope: RepositoryScope | null;
  readonly changed: readonly RepositoryContext[];
} {
  if (journal.scope === null) return { scope: null, changed: [] };
  const observations = new Map<string, RepositoryContext | null>();
  const active: RepositoryContext[] = [];
  const changed: RepositoryContext[] = [];
  for (const context of journal.scope.active) {
    const expected = [
      context,
      ...journal.scope.guards.filter(
        (guard) =>
          guard.path !== context.path &&
          (guard.path === "" || context.path.startsWith(`${guard.path}/`)),
      ),
    ];
    let unknown = false;
    let different = false;
    for (const value of expected) {
      let actual: RepositoryContext;
      try {
        const observed = observations.has(value.path)
          ? observations.get(value.path)
          : inspectRepositoryContext(config.root, value.path);
        if (observed === null || observed === undefined) {
          unknown = true;
          continue;
        }
        actual = observed;
        observations.set(value.path, actual);
      } catch {
        observations.set(value.path, null);
        unknown = true;
        continue;
      }
      if (canonicalJson(actual) !== canonicalJson(value)) different = true;
    }
    if (accepted !== undefined) {
      const remote = accepted.repositories.find(
        (value) => value.path === context.path,
      );
      if (canonicalJson(remote) !== canonicalJson(context)) different = true;
    }
    if (different) changed.push(context);
    else if (!unknown) active.push(context);
  }
  return {
    scope: applyScopeSubset(
      journal.scope,
      active,
      "Interrupted repository apply is suspended",
    ),
    changed,
  };
}

function retainChangedApplyScopes(
  config: ProductConfig,
  state: LocalState,
  accepted?: NamespaceManifest,
): void {
  for (const record of state.journals()) {
    if (record.kind !== "snapshot-apply") continue;
    const journal = snapshotApplyJournal(record.value);
    const { changed } = resumableApplyScope(config, journal, accepted);
    if (changed.length === 0 || journal.scope === null) continue;
    const changedPaths = new Set(changed.map((context) => context.path));
    const remaining = journal.scope.active.filter(
      (context) => !changedPaths.has(context.path),
    );
    const scope = applyScopeSubset(
      journal.scope,
      remaining,
      "Changed Git context retained in private recovery",
    );
    const retainedId = `held-apply:${randomUUID()}`;
    const upsert: Parameters<
      LocalState["rewriteJournals"]
    >[0]["upsert"][number][] = [
      {
        id: retainedId,
        kind: "held-snapshot-apply",
        status: "retained",
        value: {
          ...journal,
          heldPaths: [...changedPaths],
          reason: "Git context changed during interrupted apply",
        },
      },
    ];
    if (remaining.length > 0)
      upsert.push({
        id: record.id,
        kind: "snapshot-apply",
        status: record.status,
        value: {
          ...journal,
          current: projectNamespace(journal.current, scope),
          desired: projectNamespace(journal.desired, scope),
          scope,
        },
      });
    for (const child of state.journals()) {
      if (
        typeof child.value !== "object" ||
        child.value === null ||
        !("applyId" in child.value) ||
        child.value.applyId !== record.id
      )
        continue;
      const intent = parseApplyMoveIntent(child.value);
      if (intent.paths.every((path) => scopeIncludes(scope, path))) continue;
      upsert.push({
        id: child.id,
        kind: "held-move",
        status: "retained",
        value: { ...child.value, applyId: retainedId },
      });
    }
    state.rewriteJournals({
      upsert,
      remove: remaining.length === 0 ? [record.id] : [],
    });
  }
}

function parseApplyMoveIntent(value: unknown): ApplyMoveIntent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("applyId" in value) ||
    typeof value.applyId !== "string" ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    value.paths.length === 0
  )
    throw new Error("Apply move intent is invalid");
  const paths = value.paths.map((path: unknown) => {
    if (typeof path !== "string") throw new Error("Apply move path is invalid");
    normalizeRelativePath(path);
    return path;
  });
  return { applyId: value.applyId, paths };
}

async function resumePendingSnapshotApply(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  transport: HubTransport,
  checkpoint: HubCheckpoint,
  live: NamespaceManifest,
  options: SyncFolderOptions,
): Promise<boolean> {
  if (checkpoint.snapshot !== null)
    retainChangedApplyScopes(config, state, checkpoint.snapshot);
  const pending = state
    .journals()
    .filter((journal) => journal.kind === "snapshot-apply");
  if (pending.length === 0) return false;
  let applied = false;
  for (const record of [...pending].sort(
    (left, right) =>
      snapshotApplyJournal(left.value).acceptedSequence -
      snapshotApplyJournal(right.value).acceptedSequence,
  )) {
    const journal = snapshotApplyJournal(record.value);
    const { scope } = resumableApplyScope(
      config,
      journal,
      checkpoint.snapshot ?? undefined,
    );
    if (scope !== null && scope.active.length === 0) continue;
    const current =
      scope === null
        ? journal.current
        : projectNamespace(journal.current, scope);
    const desired =
      scope === null
        ? journal.desired
        : projectNamespace(journal.desired, scope);
    if (journal.folderId !== config.folderId)
      throw new Error("Snapshot apply journal belongs to another folder");
    const recoveryBase = resolve(config.stateDir, "apply-recovery");
    if (!journal.recoveryRoot.startsWith(`${recoveryBase}${sep}`))
      throw new Error("Snapshot apply recovery path escapes local state");
    const stagingBase = resolve(config.stateDir, "staging");
    if (!journal.moveStageRoot.startsWith(`${stagingBase}${sep}`))
      throw new Error("Snapshot apply staging path escapes local state");
    const history = await transport.history(config.folderId);
    if (
      !history.some(
        (event) =>
          Number(event.sequence) === journal.acceptedSequence &&
          String(event.snapshot_digest) === journal.acceptedDigest,
      )
    )
      throw new Error("Snapshot apply journal is not an accepted hub event");
    if (
      checkpoint.sequence < journal.acceptedSequence ||
      checkpoint.snapshot === null
    )
      throw new Error("Hub checkpoint is behind a pending snapshot apply");
    manifestObjectIds(desired, objects);
    const observed = applied
      ? scanNamespace(
          config,
          objects,
          ensureIgnore(config.root),
          state.catalog(),
          true,
          false,
          scope === null
            ? undefined
            : { accepted: desired, baseline: current, scope },
        ).manifest
      : live;
    const scopedLive =
      scope === null ? observed : projectNamespace(observed, scope);
    assertResumableSnapshotApply(scopedLive, current, desired);
    await applySnapshot(
      config,
      state,
      objects,
      scopedLive,
      desired,
      "normal",
      journal.acceptedSequence,
      options,
      scope,
      journal.acceptedDigest,
      record.id,
    );
    const verified = scanNamespace(
      config,
      objects,
      ensureIgnore(config.root),
      desired.entries,
      true,
      true,
      scope === null
        ? undefined
        : {
            accepted: desired,
            baseline: current,
            scope,
          },
    );
    assertDigest(verified.manifest, desired);
    const baseline = loadBaseline(config);
    if (scope !== null && baseline === null)
      throw new Error("Scoped recovery has no local baseline");
    state.replaceCatalog(
      scope === null
        ? verified.manifest.entries
        : combineScopedNamespace(
            verified.manifest,
            { ...baseline!, entries: state.catalog() },
            scope,
          ).entries,
      Math.max(state.sequence(), journal.acceptedSequence),
    );
    if (state.sequence() <= journal.acceptedSequence)
      state.acceptBaseline(journal.acceptedSequence, journal.acceptedDigest);
    saveBaseline(
      config,
      scope === null
        ? desired
        : combineScopedNamespace(desired, baseline!, scope),
    );
    const remaining =
      journal.scope?.active.filter(
        (context) =>
          !scope?.active.some((value) => value.path === context.path),
      ) ?? [];
    if (remaining.length === 0 || journal.scope === null)
      state.completeJournal(record.id);
    else {
      const waiting = applyScopeSubset(
        journal.scope,
        remaining,
        "Repository apply completed in an independent scope",
      );
      state.putJournal(record.id, "snapshot-apply", {
        ...journal,
        current: projectNamespace(journal.current, waiting),
        desired: projectNamespace(journal.desired, waiting),
        scope: waiting,
      });
    }
    applied = true;
  }
  return applied;
}

function snapshotApplyJournal(value: unknown): SnapshotApplyJournal {
  if (typeof value !== "object" || value === null)
    throw new Error("Snapshot apply journal is invalid");
  const input = value as Record<string, unknown>;
  if (
    typeof input.folderId !== "string" ||
    !Number.isSafeInteger(input.acceptedSequence) ||
    Number(input.acceptedSequence) < 1 ||
    typeof input.recoveryRoot !== "string" ||
    typeof input.moveStageRoot !== "string" ||
    typeof input.current !== "object" ||
    input.current === null ||
    typeof input.desired !== "object" ||
    input.desired === null
  )
    throw new Error("Snapshot apply journal is invalid");
  const current = input.current as NamespaceManifest;
  const desired = input.desired as NamespaceManifest;
  validateNamespaceManifest(current);
  validateNamespaceManifest(desired);
  if (
    current.folderId !== input.folderId ||
    desired.folderId !== input.folderId ||
    current.ignoreDigest !== desired.ignoreDigest ||
    canonicalJson(current.repositories) !== canonicalJson(desired.repositories)
  )
    throw new Error(
      "Apply journal snapshots do not share one folder and context",
    );
  assertHash(input.acceptedDigest as string, "Apply journal accepted digest");
  const scope =
    input.scope === null ? null : parseApplyScope(input.scope, desired);
  return {
    folderId: input.folderId,
    acceptedSequence: Number(input.acceptedSequence),
    current,
    desired,
    recoveryRoot: resolve(input.recoveryRoot),
    moveStageRoot: resolve(input.moveStageRoot),
    scope,
    acceptedDigest: input.acceptedDigest as string,
  };
}

function parseApplyScope(
  value: unknown,
  desired: NamespaceManifest,
): RepositoryScope {
  if (
    typeof value !== "object" ||
    value === null ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    !("active" in value) ||
    !("guards" in value) ||
    !Array.isArray(value.guards) ||
    !("paused" in value) ||
    !Array.isArray(value.paused)
  )
    throw new Error("Invalid apply repository scope");
  const paths: string[] = value.paths.map((path: unknown) => {
    if (typeof path !== "string")
      throw new Error("Invalid apply repository path");
    if (path !== "") normalizeRelativePath(path);
    return path;
  });
  const paused = value.paused.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("reason" in entry) ||
      typeof entry.reason !== "string"
    )
      throw new Error("Invalid paused apply repository");
    return { path: entry.path, reason: entry.reason };
  });
  if (
    canonicalJson(value.active) !== canonicalJson(desired.repositories) ||
    new Set(paths).size !== paths.length ||
    canonicalJson([...paths].sort()) !==
      canonicalJson(
        [
          ...desired.repositories.map((entry) => entry.path),
          ...paused.map((entry) => entry.path),
        ].sort(),
      )
  )
    throw new Error("Apply repository scope does not match its manifest");
  const guards = value.guards as readonly RepositoryContext[];
  validateNamespaceManifest({
    ...desired,
    repositories: guards,
    digest: semanticDigest(desired.entries, desired.ignoreDigest, guards),
  });
  if (
    guards.some(
      (guard) =>
        !paths.includes(guard.path) ||
        !desired.repositories.some(
          (child) =>
            child.path !== guard.path &&
            (guard.path === "" || child.path.startsWith(`${guard.path}/`)),
        ),
    )
  )
    throw new Error("Apply guard is not an enclosing repository");
  return { paths, active: desired.repositories, guards, paused };
}

function assertResumableSnapshotApply(
  live: NamespaceManifest,
  current: NamespaceManifest,
  desired: NamespaceManifest,
): void {
  const currentByPath = new Map(
    current.entries.map((entry) => [entry.path, entry]),
  );
  const desiredByPath = new Map(
    desired.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of live.entries)
    if (
      !sameContentOptional(entry, currentByPath.get(entry.path)) &&
      !sameContentOptional(entry, desiredByPath.get(entry.path))
    )
      throw new Error(
        `Local namespace changed during interrupted apply: ${entry.path}`,
      );
}

async function applySnapshot(
  config: ProductConfig,
  state: LocalState,
  objects: ObjectStore,
  current: NamespaceManifest,
  desired: NamespaceManifest,
  recoveryKind: "adoption" | "normal",
  acceptedSequence = 0,
  options: SyncFolderOptions = {},
  scope: RepositoryScope | null = null,
  acceptedDigest = desired.digest,
  resumedJournalId: string | null = null,
): Promise<string | null> {
  validateNamespacePolicy(desired, config);
  using gitLease = acquireGitLease(config, current.repositories, scope?.guards);
  assertRepositoryContexts(config, current, desired, scope);
  for (const entry of desired.entries) {
    if (entry.kind === "directory") continue;
    const target = safeTarget(config.root, entry.path);
    if (
      pathExists(target) &&
      lstatSync(target).isDirectory() &&
      !directoryFullyIncluded(config, entry.path, current)
    )
      throw new Error(
        "A selected file would replace a directory containing local-only data",
      );
  }
  const journalId =
    recoveryKind === "normal"
      ? (resumedJournalId ?? `snapshot-apply:${desired.digest}`)
      : null;
  const existingJournal =
    journalId === null
      ? null
      : (state.journals().find((journal) => journal.id === journalId) ?? null);
  const recoveryRoot =
    existingJournal === null
      ? join(
          config.stateDir,
          "apply-recovery",
          `${recoveryKind}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
        )
      : snapshotApplyJournal(existingJournal.value).recoveryRoot;
  const moveStageRoot =
    existingJournal === null
      ? join(config.stateDir, "staging", `moves-${desired.digest}`)
      : snapshotApplyJournal(existingJournal.value).moveStageRoot;
  if (journalId !== null && existingJournal === null) {
    state.putJournal(journalId, "snapshot-apply", {
      folderId: config.folderId,
      acceptedSequence,
      current,
      desired,
      recoveryRoot,
      moveStageRoot,
      scope,
      acceptedDigest,
    });
    options.fault?.("after-apply-journal");
  }
  if (recoveryKind === "normal") {
    const observed = scanNamespace(
      config,
      objects,
      ensureIgnore(config.root),
      current.entries,
      true,
      false,
      scope === null
        ? undefined
        : { accepted: desired, baseline: current, scope },
    );
    if (observed.manifest.digest !== current.digest)
      throw new Error(
        `Local namespace changed before remote apply: ${manifestDifference(current, observed.manifest)}`,
      );
  }
  const currentByNode = new Map(
    current.entries.map((entry) => [entry.nodeId, entry]),
  );
  const desiredByNode = new Map(
    desired.entries.map((entry) => [entry.nodeId, entry]),
  );
  const interruptedCurrent =
    existingJournal === null
      ? new Map<string, CatalogEntry>()
      : new Map(
          snapshotApplyJournal(existingJournal.value).current.entries.map(
            (entry) => [entry.nodeId, entry],
          ),
        );
  const moves = desired.entries
    .map((entry) => {
      const live = currentByNode.get(entry.nodeId);
      const prior = interruptedCurrent.get(entry.nodeId);
      const staged = join(moveStageRoot, entry.nodeId);
      return {
        from:
          live ??
          (prior !== undefined && pathExists(staged) ? prior : undefined),
        to: entry,
      };
    })
    .filter(
      (value): value is { from: CatalogEntry; to: CatalogEntry } =>
        value.from !== undefined && value.from.path !== value.to.path,
    )
    .filter(
      (move) =>
        move.from.kind !== "directory" ||
        directoryFullyIncluded(config, move.from.path, current),
    )
    .filter(
      (move, _index, values) =>
        !values.some(
          (parent) =>
            parent !== move &&
            move.from.path.startsWith(`${parent.from.path}/`) &&
            move.to.path.startsWith(`${parent.to.path}/`),
        ),
    )
    .sort((left, right) => depth(right.from.path) - depth(left.from.path));
  const stagedMoves = new Map<string, string>();
  for (const move of moves) {
    const from = safeTarget(config.root, move.from.path);
    const stage = join(moveStageRoot, move.from.nodeId);
    if (pathExists(from) && !pathExists(stage)) {
      mkdirSync(dirname(stage), { recursive: true, mode: 0o700 });
      renameWithJournal(
        state,
        from,
        stage,
        journalId === null
          ? undefined
          : { applyId: journalId, paths: [move.from.path, move.to.path] },
      );
    }
    if (pathExists(stage)) stagedMoves.set(move.from.nodeId, stage);
  }
  options.fault?.("after-moves-staged");

  const desiredPaths = new Set(desired.entries.map((entry) => entry.path));
  const obsolete = current.entries
    .filter((entry) => !desiredPaths.has(entry.path))
    .filter(
      (entry, _index, values) =>
        !values.some(
          (parent) =>
            parent !== entry && entry.path.startsWith(`${parent.path}/`),
        ),
    )
    .sort((left, right) => depth(right.path) - depth(left.path));
  for (const entry of obsolete) {
    const live = safeTarget(config.root, entry.path);
    if (!pathExists(live)) continue;
    moveScopedWithJournal(
      config,
      state,
      live,
      safeRecoveryTarget(recoveryRoot, entry.path),
      "apply-recovery",
      current,
      journalId,
    );
  }
  options.fault?.("after-obsolete-recovery");

  for (const move of [...moves].sort(
    (left, right) => depth(left.to.path) - depth(right.to.path),
  )) {
    const stage = stagedMoves.get(move.from.nodeId);
    if (stage === undefined || !pathExists(stage)) continue;
    const to = safeTarget(config.root, move.to.path);
    if (
      pathExists(to) &&
      lstatSync(to).isDirectory() &&
      !directoryFullyIncluded(config, move.to.path, current)
    )
      throw new Error(
        "A scoped move would displace local-only directory contents",
      );
    if (pathExists(to))
      moveWithJournal(
        state,
        to,
        safeRecoveryTarget(recoveryRoot, move.to.path),
        "apply-recovery",
        journalId === null
          ? undefined
          : { applyId: journalId, paths: [move.from.path, move.to.path] },
      );
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    renameWithJournal(
      state,
      stage,
      to,
      journalId === null
        ? undefined
        : { applyId: journalId, paths: [move.from.path, move.to.path] },
    );
  }
  options.fault?.("after-moves-placed");

  for (const entry of desired.entries
    .filter((value) => value.kind === "directory")
    .sort((left, right) => depth(left.path) - depth(right.path))) {
    const target = safeTarget(config.root, entry.path);
    if (pathExists(target)) {
      const stat = lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
      moveWithJournal(
        state,
        target,
        safeRecoveryTarget(recoveryRoot, entry.path),
        "apply-recovery",
        journalId === null
          ? undefined
          : { applyId: journalId, paths: [entry.path] },
      );
    }
    mkdirSync(target, { recursive: false, mode: 0o700 });
  }
  options.fault?.("after-directories");
  const currentByPath = new Map(
    current.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of desired.entries.filter(
    (value) => value.kind !== "directory",
  )) {
    const target = safeTarget(config.root, entry.path);
    const existing = currentByPath.get(entry.path);
    if (
      pathExists(target) &&
      existing !== undefined &&
      sameContent(existing, entry)
    )
      continue;
    if (pathExists(target))
      moveWithJournal(
        state,
        target,
        safeRecoveryTarget(recoveryRoot, entry.path),
        "apply-recovery",
        journalId === null
          ? undefined
          : { applyId: journalId, paths: [entry.path] },
      );
    if (entry.manifestId === null)
      throw new Error(`Desired leaf has no manifest: ${entry.path}`);
    const stage = join(config.stateDir, "staging", randomUUID());
    materializeManifest(entry.manifestId, stage, objects);
    if (entry.kind === "regular" && isPlaintextEnvPath(entry.path))
      chmodSync(stage, 0o600);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(stage, target);
  }
  options.fault?.("after-leaves");
  return journalId;
}

function mergeSnapshots(
  config: ProductConfig,
  baseline: NamespaceManifest,
  local: NamespaceManifest,
  remote: NamespaceManifest,
  objects: ObjectStore,
): {
  readonly manifest: NamespaceManifest;
  readonly conflicts: ConflictRecord[];
} {
  const base = new Map(baseline.entries.map((entry) => [entry.nodeId, entry]));
  const ours = new Map(local.entries.map((entry) => [entry.nodeId, entry]));
  const theirs = new Map(remote.entries.map((entry) => [entry.nodeId, entry]));
  const nodeIds = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const resultByNode = new Map<string, CatalogEntry>();
  const conflictEntries: CatalogEntry[] = [];
  const handledNodes = new Set<string>();
  const conflicts: ConflictRecord[] = [];
  const eventId = randomUUID();
  const preserveLocal = (
    entry: CatalogEntry,
    originalPath: string,
    reason: string,
    remoteRoot?: CatalogEntry,
    baselineRoot?: CatalogEntry,
  ) => {
    if (entry.kind === "directory") {
      const visible = conflictPath(entry.path, config.peerName, eventId);
      for (const candidate of local.entries.filter(
        (value) =>
          value.path === entry.path || value.path.startsWith(`${entry.path}/`),
      )) {
        resultByNode.delete(candidate.nodeId);
        const suffix = candidate.path.slice(entry.path.length);
        conflictEntries.push(
          entryAtPath(candidate, `${visible}${suffix}`, randomUUID()),
        );
        handledNodes.add(candidate.nodeId);
      }
      if (remoteRoot !== undefined)
        for (const candidate of remote.entries.filter(
          (value) =>
            value.path === remoteRoot.path ||
            value.path.startsWith(`${remoteRoot.path}/`),
        )) {
          resultByNode.set(candidate.nodeId, candidate);
          handledNodes.add(candidate.nodeId);
        }
      if (baselineRoot !== undefined)
        for (const candidate of baseline.entries.filter(
          (value) =>
            value.path === baselineRoot.path ||
            value.path.startsWith(`${baselineRoot.path}/`),
        ))
          handledNodes.add(candidate.nodeId);
      conflicts.push({
        conflictId: randomUUID(),
        kind: "normal",
        peerId: config.peerId,
        originalPath,
        recoveryPath: visible,
        manifestId: captureSnapshotSubtree(entry, local, objects),
        reason,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    const visible = conflictPath(entry.path, config.peerName, eventId);
    conflictEntries.push(entryAtPath(entry, visible, randomUUID()));
    conflicts.push({
      conflictId: randomUUID(),
      kind: "normal",
      peerId: config.peerId,
      originalPath,
      recoveryPath: visible,
      manifestId: entry.manifestId,
      reason,
      createdAt: new Date().toISOString(),
    });
  };
  const orderedNodeIds = [...nodeIds].sort((left, right) => {
    const leftPath =
      base.get(left)?.path ??
      ours.get(left)?.path ??
      theirs.get(left)?.path ??
      "";
    const rightPath =
      base.get(right)?.path ??
      ours.get(right)?.path ??
      theirs.get(right)?.path ??
      "";
    return (
      depth(leftPath) - depth(rightPath) ||
      leftPath.localeCompare(rightPath, "en")
    );
  });
  for (const nodeId of orderedNodeIds) {
    if (handledNodes.has(nodeId)) continue;
    const before = base.get(nodeId);
    const localEntry = ours.get(nodeId);
    const remoteEntry = theirs.get(nodeId);
    if (before === undefined) {
      if (remoteEntry !== undefined) {
        resultByNode.set(nodeId, remoteEntry);
        if (localEntry !== undefined && !entryEqual(localEntry, remoteEntry))
          preserveLocal(
            localEntry,
            remoteEntry.path,
            "concurrent creation in the current Git context",
            remoteEntry,
          );
      } else if (localEntry !== undefined) resultByNode.set(nodeId, localEntry);
      continue;
    }
    if (localEntry === undefined && remoteEntry === undefined) continue;
    if (localEntry === undefined) {
      if (entryEqual(remoteEntry, before)) continue;
      if (remoteEntry !== undefined) resultByNode.set(nodeId, remoteEntry);
      conflicts.push({
        conflictId: randomUUID(),
        kind: "normal",
        peerId: config.peerId,
        originalPath: before.path,
        recoveryPath: "",
        manifestId: null,
        reason: "delete conflicted with an accepted mutation",
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    if (remoteEntry === undefined) {
      if (entryEqual(localEntry, before)) continue;
      preserveLocal(
        localEntry,
        before.path,
        "accepted delete conflicted with a local mutation",
        undefined,
        before,
      );
      continue;
    }
    const placement = mergeEntryComponent(
      before,
      localEntry,
      remoteEntry,
      (left, right) => left.path === right.path,
    );
    const content = mergeEntryComponent(
      before,
      localEntry,
      remoteEntry,
      sameContent,
    );
    if (placement === null || content === null) {
      resultByNode.set(nodeId, remoteEntry);
      preserveLocal(
        localEntry,
        remoteEntry.path,
        "concurrent mutation",
        remoteEntry,
        before,
      );
      continue;
    }
    resultByNode.set(nodeId, mergeEntryPlacementAndContent(placement, content));
  }
  const slots = new Map<string, CatalogEntry[]>();
  for (const entry of resultByNode.values()) {
    const slot = `${entry.parentPath ?? ""}/${entry.portableName}`;
    const values = slots.get(slot) ?? [];
    values.push(entry);
    slots.set(slot, values);
  }
  const remoteNodes = new Set(remote.entries.map((entry) => entry.nodeId));
  for (const values of slots.values()) {
    const active = values.filter((entry) => resultByNode.has(entry.nodeId));
    if (active.length < 2) continue;
    const winner =
      active.find((entry) => remoteNodes.has(entry.nodeId)) ?? active[0];
    if (winner === undefined) continue;
    for (const loser of active) {
      if (loser.nodeId === winner.nodeId) continue;
      resultByNode.delete(loser.nodeId);
      preserveLocal(
        loser,
        winner.path,
        "concurrent path or portable-name collision",
        winner,
        base.get(loser.nodeId),
      );
    }
  }
  const result = new Map<string, CatalogEntry>();
  for (const entry of [...resultByNode.values(), ...conflictEntries]) {
    if (result.has(entry.path))
      throw new Error(
        `Concurrent mutations occupy the same path: ${entry.path}`,
      );
    result.set(entry.path, entry);
  }
  ensureParentDirectories(result, remote, local);
  const entries = assignParentNodeIds([...result.values()]);
  return {
    manifest: {
      schemaVersion,
      folderId: config.folderId,
      ignoreDigest: config.ignoreDigest,
      entries,
      repositories: local.repositories,
      createdAt: new Date().toISOString(),
      digest: semanticDigest(entries, config.ignoreDigest, local.repositories),
    },
    conflicts,
  };
}

function captureSnapshotSubtree(
  root: CatalogEntry,
  snapshot: NamespaceManifest,
  objects: ObjectStore,
): string {
  if (root.kind !== "directory")
    throw new Error(`Conflict subtree is not a directory: ${root.path}`);
  const children = new Map<string, CatalogEntry[]>();
  for (const entry of snapshot.entries) {
    if (entry.parentPath === null) continue;
    const values = children.get(entry.parentPath) ?? [];
    values.push(entry);
    children.set(entry.parentPath, values);
  }
  const capture = (directoryPath: string): string => {
    const entries: TreeManifestEntry[] = [];
    for (const entry of (children.get(directoryPath) ?? []).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    )) {
      const manifestId =
        entry.kind === "directory" ? capture(entry.path) : entry.manifestId;
      if (manifestId === null)
        throw new Error(`Conflict leaf has no manifest: ${entry.path}`);
      entries.push({ name: entry.name, kind: entry.kind, manifestId });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    const manifest: TreeManifest = {
      schemaVersion,
      type: "tree",
      entries,
      digest: hashJson(entries),
    };
    return objects.put(Buffer.from(canonicalJson(manifest), "utf8"));
  };
  return capture(root.path);
}

function mergeEntryComponent(
  baseline: CatalogEntry,
  local: CatalogEntry,
  remote: CatalogEntry,
  equal: (left: CatalogEntry, right: CatalogEntry) => boolean,
): CatalogEntry | null {
  if (equal(local, baseline)) return remote;
  if (equal(remote, baseline) || equal(local, remote)) return local;
  return null;
}

function mergeEntryPlacementAndContent(
  placement: CatalogEntry,
  content: CatalogEntry,
): CatalogEntry {
  return entryAtPath(content, placement.path, placement.nodeId);
}

function entryAtPath(
  entry: CatalogEntry,
  path: string,
  nodeId: string,
): CatalogEntry {
  const name = path.split("/").at(-1) ?? path;
  const parent = dirname(path).replaceAll(sep, "/");
  return {
    ...entry,
    path,
    parentPath: parent === "." ? null : parent,
    parentNodeId: parent === "." ? "$root" : entry.parentNodeId,
    name,
    portableName: portableName(name),
    nodeId,
  };
}

function assignParentNodeIds(
  values: readonly CatalogEntry[],
): readonly CatalogEntry[] {
  const sorted = [...values].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const nodes = new Map(sorted.map((entry) => [entry.path, entry.nodeId]));
  return sorted.map((entry) => ({
    ...entry,
    parentNodeId:
      entry.parentPath === null ? "$root" : (nodes.get(entry.parentPath) ?? ""),
  }));
}

function ensureParentDirectories(
  entries: Map<string, CatalogEntry>,
  remote: NamespaceManifest,
  local: NamespaceManifest,
): void {
  const candidates = new Map(
    [...remote.entries, ...local.entries]
      .filter((entry) => entry.kind === "directory")
      .map((entry) => [entry.path, entry]),
  );
  for (const entry of [...entries.values()]) {
    let parent = entry.parentPath;
    while (parent !== null) {
      if (!entries.has(parent)) {
        const candidate = candidates.get(parent);
        if (candidate === undefined)
          throw new Error(
            `Merged entry has no recoverable parent: ${entry.path}`,
          );
        entries.set(parent, candidate);
      }
      const value = entries.get(parent);
      parent = value?.parentPath ?? null;
    }
  }
}

function recoverInterruptedApplies(
  config: ProductConfig,
  state: LocalState,
): void {
  recoverGitLease(config);
  retainChangedApplyScopes(config, state);
  const applies = new Map(
    state
      .journals()
      .filter((journal) => journal.kind === "snapshot-apply")
      .map((journal) => [journal.id, snapshotApplyJournal(journal.value)]),
  );
  for (const journal of state.journals()) {
    if (
      journal.kind === "adoption-apply" ||
      journal.kind === "snapshot-apply" ||
      journal.kind === "held-snapshot-apply" ||
      journal.kind === "held-move" ||
      journal.kind === "cutover" ||
      journal.kind === "authority-setup" ||
      journal.kind === "peer-role" ||
      journal.kind === "config-projection"
    )
      continue;
    if (typeof journal.value !== "object" || journal.value === null)
      throw new Error(`Invalid recovery journal: ${journal.id}`);
    const value = journal.value as Record<string, unknown>;
    if ("applyId" in value) {
      const intent = parseApplyMoveIntent(value);
      const parent = applies.get(intent.applyId);
      if (parent === undefined)
        throw new Error("Apply move has no pending parent transaction");
      const { scope } = resumableApplyScope(config, parent);
      if (
        scope !== null &&
        !intent.paths.every((path) => scopeIncludes(scope, path))
      )
        continue;
    }
    const source =
      typeof value.source === "string" ? resolve(value.source) : null;
    const destination =
      typeof value.destination === "string" ? resolve(value.destination) : null;
    if (source === null || destination === null)
      throw new Error(`Invalid recovery journal: ${journal.id}`);
    const roots = [resolve(config.root), resolve(config.stateDir)];
    if (
      ![source, destination].every((path) =>
        roots.some((root) => path.startsWith(`${root}${sep}`)),
      )
    )
      throw new Error(`Recovery journal escapes owned paths: ${journal.id}`);
    for (const path of [source, destination]) {
      const root = roots.find((root) => path.startsWith(`${root}${sep}`));
      if (root === undefined) throw new Error("Recovery parent is not owned");
      safeTarget(root, relative(root, path).replaceAll(sep, "/"));
    }
    if (!pathExists(source) && pathExists(destination)) {
      mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
      renameSync(destination, source);
    }
    state.completeJournal(journal.id);
  }
}

function renameWithJournal(
  state: LocalState,
  source: string,
  destination: string,
  intent?: ApplyMoveIntent,
): void {
  const id = randomUUID();
  state.putJournal(id, "rename", { source, destination, ...intent });
  renameSync(source, destination);
  state.completeJournal(id);
}

function moveWithJournal(
  state: LocalState,
  source: string,
  destination: string,
  kind: string,
  intent?: ApplyMoveIntent,
): void {
  if (pathExists(destination))
    throw new Error(`Recovery destination already exists: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  state.putJournal(id, kind, { source, destination, ...intent });
  renameSync(source, destination);
  state.completeJournal(id);
}

/** A subtree rename is allowed only when it contains no local-only entries. */
function directoryFullyIncluded(
  config: ProductConfig,
  path: string,
  snapshot: NamespaceManifest,
): boolean {
  const included = new Set(snapshot.entries.map((entry) => entry.path));
  const walk = (directory: string, relativeDirectory: string): boolean => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${child.name}`;
      if (!included.has(relativePath)) return false;
      if (
        child.isDirectory() &&
        !child.isSymbolicLink() &&
        !walk(join(directory, child.name), relativePath)
      )
        return false;
    }
    return true;
  };
  const source = safeTarget(config.root, path);
  return !pathExists(source) || walk(source, path);
}

/** Recover selected contents without moving an excluded sibling or Git tree. */
function moveScopedWithJournal(
  config: ProductConfig,
  state: LocalState,
  source: string,
  destination: string,
  kind: string,
  snapshot: NamespaceManifest,
  applyId: string | null = null,
): void {
  const path = relative(config.root, source).replaceAll(sep, "/");
  if (
    !lstatSync(source).isDirectory() ||
    directoryFullyIncluded(config, path, snapshot)
  ) {
    moveWithJournal(
      state,
      source,
      destination,
      kind,
      applyId === null ? undefined : { applyId, paths: [path] },
    );
    return;
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const included = new Set(snapshot.entries.map((entry) => entry.path));
  for (const child of readdirSync(source, { withFileTypes: true })) {
    if (!included.has(`${path}/${child.name}`)) continue;
    moveScopedWithJournal(
      config,
      state,
      join(source, child.name),
      join(destination, child.name),
      kind,
      snapshot,
      applyId,
    );
  }
  if (readdirSync(source).length === 0) rmdirSync(source);
}

function safeRecoveryTarget(root: string, path: string): string {
  const target = resolve(root, ...path.split("/"));
  const absolute = resolve(root);
  if (target !== absolute && !target.startsWith(`${absolute}${sep}`))
    throw new Error(`Recovery path escapes owned root: ${path}`);
  return target;
}

function assertAcceptedConfig(
  config: ProductConfig,
  checkpoint: HubCheckpoint,
): void {
  verifyConfig(checkpoint.config);
  if (
    checkpoint.config.folderId !== config.folderId ||
    checkpoint.config.revision !== config.revision ||
    checkpoint.config.signature !== config.signature ||
    checkpoint.config.ignoreDigest !== config.ignoreDigest ||
    checkpoint.config.lifecycle !== config.lifecycle
  )
    throw new Error(
      "Local configuration projection differs from hub authority",
    );
}

function assertRepositoryContexts(
  config: ProductConfig,
  current: NamespaceManifest,
  desired: NamespaceManifest,
  scope: RepositoryScope | null = null,
): void {
  if (config.syncPolicy.mode !== "default-branch") return;
  for (const context of scope?.guards ?? [])
    assertStableRepositoryContext(
      inspectRepositoryContext(config.root, context.path),
      context,
    );
  if (current.repositories.length !== desired.repositories.length)
    throw new Error("Repository scope differs; synchronization is paused");
  const localByPath = new Map(
    current.repositories.map((repository) => [repository.path, repository]),
  );
  for (const accepted of desired.repositories) {
    const local = localByPath.get(accepted.path);
    if (local === undefined)
      throw new Error("Repository scope differs; synchronization is paused");
    assertMatchingRepositoryContext(config.syncPolicy, local, accepted);
    assertMatchingRepositoryContext(
      config.syncPolicy,
      inspectRepositoryContext(config.root, local.path),
      local,
    );
  }
}

function saveBaseline(
  config: ProductConfig,
  manifest: NamespaceManifest,
): void {
  const path = join(config.stateDir, "baseline.json");
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadBaseline(config: ProductConfig): NamespaceManifest | null {
  const path = join(config.stateDir, "baseline.json");
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as NamespaceManifest;
  validateNamespaceManifest(manifest);
  return manifest;
}

function adoptionPlanPath(config: ProductConfig, adoptionId: string): string {
  if (!/^[a-f0-9-]{36}$/iu.test(adoptionId))
    throw new Error("Adoption ID is invalid");
  return join(config.stateDir, "plans", `${adoptionId}.json`);
}

function loadAdoptionPlan(
  config: ProductConfig,
  adoptionId: string,
): AdoptionPlan {
  const envelope = JSON.parse(
    readFileSync(adoptionPlanPath(config, adoptionId), "utf8"),
  ) as {
    readonly version?: unknown;
    readonly iv?: unknown;
    readonly tag?: unknown;
    readonly ciphertext?: unknown;
  };
  if (
    envelope.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("Encrypted adoption plan envelope is invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    readPlanKey(config),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const bytes = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const plan = JSON.parse(bytes.toString("utf8")) as AdoptionPlan;
  if (
    plan.schemaVersion !== schemaVersion ||
    plan.folderId !== config.folderId ||
    plan.targetPeerId !== config.peerId ||
    plan.adoptionId !== adoptionId
  )
    throw new Error("Adoption plan does not belong to this peer and folder");
  validateNamespaceManifest(plan.targetSnapshot);
  if (plan.targetSnapshot.digest !== plan.targetDigest)
    throw new Error("Adoption plan target snapshot does not match its digest");
  return plan;
}

function writeEncryptedPlan(
  config: ProductConfig,
  path: string,
  plan: AdoptionPlan,
): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", readPlanKey(config, true), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plan), "utf8")),
    cipher.final(),
  ]);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

function readPlanKey(config: ProductConfig, create = false): Buffer {
  const path = join(config.stateDir, "keys", "adoption-plan.key");
  if (!existsSync(path)) {
    if (!create) throw new Error("Adoption plan key is missing");
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Adoption plan key is invalid");
  return key;
}

function assertDigest(
  actual: NamespaceManifest,
  expected: NamespaceManifest,
): void {
  if (actual.digest !== expected.digest)
    throw new Error(
      "Applied namespace failed independent semantic verification",
    );
}

function manifestDifference(
  expected: NamespaceManifest,
  actual: NamespaceManifest,
): string {
  const expectedEntries = new Map(
    expected.entries.map((entry) => [entry.path, entry]),
  );
  const actualEntries = new Map(
    actual.entries.map((entry) => [entry.path, entry]),
  );
  for (const path of new Set([
    ...expectedEntries.keys(),
    ...actualEntries.keys(),
  ])) {
    const left = expectedEntries.get(path);
    const right = actualEntries.get(path);
    if (left?.nodeId !== right?.nodeId) return `${path} (node identity)`;
    if (left?.kind !== right?.kind) return `${path} (object kind)`;
    if (left?.manifestId !== right?.manifestId)
      return `${path} (content manifest)`;
    if (left?.executable !== right?.executable)
      return `${path} (executable bit)`;
  }
  return "semantic digest changed without a visible entry difference";
}

function sameContent(left: CatalogEntry, right: CatalogEntry): boolean {
  return (
    left.kind === right.kind &&
    left.manifestId === right.manifestId &&
    left.executable === right.executable
  );
}

function sameContentOptional(
  left: CatalogEntry | undefined,
  right: CatalogEntry | undefined,
): boolean {
  return left !== undefined && right !== undefined && sameContent(left, right);
}

function contentKey(entry: CatalogEntry): string {
  return canonicalJson({
    kind: entry.kind,
    manifestId: entry.manifestId,
    executable: entry.executable,
  });
}

function entryEqual(
  left: CatalogEntry | undefined,
  right: CatalogEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.path === right.path &&
    left.nodeId === right.nodeId &&
    sameContent(left, right)
  );
}

function emptyAdoptionSummary(): Record<AdoptionClassification, number> {
  return {
    exact: 0,
    "source-only": 0,
    "target-only": 0,
    divergent: 0,
    "moved-equivalent": 0,
    "type-conflicting": 0,
    unrepresentable: 0,
  };
}

function summary(
  config: ProductConfig,
  scanned: ScanResult,
  hubSequence: number,
  published: boolean,
  applied: boolean,
  uploadedObjects: number,
  downloadedObjects: number,
  conflicts = 0,
): SyncSummary {
  return {
    folderId: config.folderId,
    peerId: config.peerId,
    status: conflicts > 0 ? "conflict" : "clean",
    scanned: scanned.manifest.entries.length,
    published,
    applied,
    conflicts,
    uploadedObjects,
    downloadedObjects,
    hubSequence,
    reasons: [],
  };
}

function depth(path: string): number {
  return path.split("/").length;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeConflictCount(conflicts: readonly ConflictRecord[]): number {
  return conflicts.filter((conflict) => conflict.kind === "normal").length;
}

function adoptionConflictCount(
  config: ProductConfig,
  state: LocalState,
  adoptionId: string,
): number {
  const root = resolve(config.stateDir, "adoption-recovery", adoptionId);
  return state.conflicts().filter((conflict) => {
    const recovery = resolve(conflict.recoveryPath);
    return recovery === root || recovery.startsWith(`${root}${sep}`);
  }).length;
}
