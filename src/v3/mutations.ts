import { canonicalJson, hashJson } from "../v2/hash.js";
import { referencedObjects, type ObjectStore } from "./objects.js";
import type {
  CatalogEntry,
  GitBoundary,
  NamespaceManifest,
  NamespaceMutation,
} from "./types.js";

interface MutationConfig {
  readonly folderId: string;
  readonly peerId: string;
  readonly revision: number;
}

type UnsignedMutation = NamespaceMutation extends infer Mutation
  ? Mutation extends { readonly eventId: string }
    ? Omit<Mutation, "eventId">
    : never
  : never;

export function entryVersion(entry: CatalogEntry): string {
  return hashJson({
    parentNodeId: entry.parentNodeId,
    parentPath: entry.parentPath,
    name: entry.name,
    portableName: entry.portableName,
  });
}

export function contentVersion(entry: CatalogEntry): string {
  return hashJson({
    kind: entry.kind,
    manifestId: entry.manifestId,
    executable: entry.executable,
  });
}

export function deriveMutations(input: {
  readonly config: MutationConfig;
  readonly eventId: string;
  readonly peerSequence: number;
  readonly base: NamespaceManifest | null;
  readonly next: NamespaceManifest;
  readonly objects: ObjectStore;
  readonly restoredNodeIds?: ReadonlySet<string>;
}): readonly NamespaceMutation[] {
  const baseEntries = new Map(
    (input.base?.entries ?? []).map((entry) => [entry.nodeId, entry]),
  );
  const nextEntries = new Map(
    input.next.entries.map((entry) => [entry.nodeId, entry]),
  );
  const mutations: UnsignedMutation[] = [];
  for (const nodeId of new Set([
    ...baseEntries.keys(),
    ...nextEntries.keys(),
  ])) {
    const before = baseEntries.get(nodeId);
    const after = nextEntries.get(nodeId);
    const common = mutationBase(input, nodeId, before);
    if (before === undefined && after !== undefined) {
      mutations.push({
        ...common,
        kind: input.restoredNodeIds?.has(nodeId) ? "restore-entry" : "put-node",
        path: after.path,
        entryVersion: entryVersion(after),
        contentVersion: contentVersion(after),
        objectIds: entryObjects(after, input.objects),
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      mutations.push({
        ...common,
        kind: "delete-entry",
        path: before.path,
        entryVersion: null,
        contentVersion: null,
        objectIds: entryObjects(before, input.objects),
      });
      continue;
    }
    if (before === undefined || after === undefined) continue;
    if (entryVersion(before) !== entryVersion(after))
      mutations.push({
        ...common,
        kind: "move-entry",
        fromPath: before.path,
        path: after.path,
        entryVersion: entryVersion(after),
        contentVersion: contentVersion(after),
        objectIds: entryObjects(after, input.objects),
      });
    if (contentVersion(before) !== contentVersion(after))
      mutations.push({
        ...common,
        kind: "put-node",
        path: after.path,
        entryVersion: entryVersion(after),
        contentVersion: contentVersion(after),
        objectIds: entryObjects(after, input.objects),
      });
  }

  const baseGit = gitByNode(input.base);
  const nextGit = gitByNode(input.next);
  for (const nodeId of new Set([...baseGit.keys(), ...nextGit.keys()])) {
    const before = baseGit.get(nodeId);
    const after = nextGit.get(nodeId);
    if (canonicalJson(before) === canonicalJson(after)) continue;
    mutations.push({
      ...mutationBase(input, nodeId, undefined),
      kind: "git-state",
      path: after?.worktreePath ?? before?.worktreePath ?? "",
      baseEntryVersion: before === undefined ? null : gitEntryVersion(before),
      baseContentVersion:
        before === undefined ? null : gitContentVersion(before),
      entryVersion: after === undefined ? null : gitEntryVersion(after),
      contentVersion: after === undefined ? null : gitContentVersion(after),
      objectIds:
        after === undefined
          ? before === undefined
            ? []
            : [...referencedObjects(before.manifestId, input.objects)].sort()
          : [...referencedObjects(after.manifestId, input.objects)].sort(),
    });
  }

  return mutations
    .sort((left, right) =>
      `${left.nodeId}\0${left.kind}\0${"path" in left ? left.path : ""}`.localeCompare(
        `${right.nodeId}\0${right.kind}\0${"path" in right ? right.path : ""}`,
        "en",
      ),
    )
    .map((mutation, index) => ({
      ...mutation,
      eventId: `${input.eventId}:mutation:${index}`,
    })) as readonly NamespaceMutation[];
}

function mutationBase(
  input: {
    readonly config: MutationConfig;
    readonly eventId: string;
    readonly peerSequence: number;
  },
  nodeId: string,
  before: CatalogEntry | undefined,
) {
  return {
    folderId: input.config.folderId,
    peerId: input.config.peerId,
    eventId: input.eventId,
    peerSequence: input.peerSequence,
    baseConfigRevision: input.config.revision,
    nodeId,
    baseEntryVersion: before === undefined ? null : entryVersion(before),
    baseContentVersion: before === undefined ? null : contentVersion(before),
    objectIds: [] as readonly string[],
  };
}

function entryObjects(
  entry: CatalogEntry,
  objects: ObjectStore,
): readonly string[] {
  return entry.manifestId === null
    ? []
    : [...referencedObjects(entry.manifestId, objects)].sort();
}

function gitByNode(
  snapshot: NamespaceManifest | null,
): Map<string, GitBoundary> {
  if (snapshot === null) return new Map();
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  return new Map(
    snapshot.gitBoundaries.map((boundary) => {
      const nodeId =
        boundary.worktreePath === ""
          ? "$root-git"
          : entries.get(boundary.worktreePath)?.nodeId;
      if (nodeId === undefined)
        throw new Error(
          `Git boundary has no worktree node: ${boundary.worktreePath}`,
        );
      return [`git:${nodeId}`, boundary] as const;
    }),
  );
}

function gitEntryVersion(boundary: GitBoundary): string {
  return hashJson({
    worktreePath: boundary.worktreePath,
    gitPath: boundary.gitPath,
    kind: boundary.kind,
  });
}

function gitContentVersion(boundary: GitBoundary): string {
  return hashJson({ manifestId: boundary.manifestId });
}
