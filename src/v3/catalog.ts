import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertHash, hashJson, hashText } from "../v2/hash.js";
import type { CompiledIgnore } from "./ignore.js";
import {
  captureGitTree,
  capturePath,
  referencedObjects,
  type ObjectStore,
} from "./objects.js";
import { normalizeRelativePath, portableName } from "./paths.js";
import {
  inspectRepositoryContext,
  assertMatchingRepositoryContext,
  assertStableRepositoryContext,
  policyIncludes,
  policyIncludesDirectory,
  repositoryMetadata,
} from "./policy.js";
import {
  schemaVersion,
  type CatalogEntry,
  type GitBoundary,
  type NamespaceManifest,
  type ProductConfig,
  type RepositoryContext,
} from "./types.js";

export interface ScanResult {
  readonly manifest: NamespaceManifest;
  readonly objectIds: readonly string[];
  readonly reusedFiles: number;
  readonly capturedFiles: number;
  readonly scope: RepositoryScope | null;
}

export interface RepositoryScope {
  readonly paths: readonly string[];
  readonly active: readonly RepositoryContext[];
  readonly guards: readonly RepositoryContext[];
  readonly paused: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

export interface RepositoryScanOptions {
  readonly accepted: NamespaceManifest;
  readonly baseline: NamespaceManifest | null;
  readonly scope?: RepositoryScope;
}

const scopeLookups = new WeakMap<
  RepositoryScope,
  { readonly paths: readonly string[]; readonly active: ReadonlySet<string> }
>();

export function scanNamespace(
  config: ProductConfig,
  store: ObjectStore,
  ignore: CompiledIgnore,
  baseline: readonly CatalogEntry[] = [],
  forceHash = false,
  trustBaselinePaths = false,
  scoped?: RepositoryScanOptions,
): ScanResult {
  if (ignore.digest !== config.ignoreDigest)
    throw new Error(
      "Ignore contract does not match the accepted configuration",
    );
  const root = resolve(config.root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Configured root must be a physical directory");
  const byPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const baselineParents = new Set(baseline.map((entry) => entry.parentPath));
  const logicalEmptyDirectories = new Set(
    baseline
      .filter(
        (entry) =>
          entry.kind === "directory" && !baselineParents.has(entry.path),
      )
      .map((entry) => entry.path),
  );
  const byIdentity = new Map<string, CatalogEntry[]>();
  for (const entry of baseline) {
    const key = `${entry.device}:${entry.inode}`;
    const values = byIdentity.get(key) ?? [];
    values.push(entry);
    byIdentity.set(key, values);
  }
  const claimed = new Set<string>();
  const entries: CatalogEntry[] = [];
  const nodeByPath = new Map<string, string>();
  const gitBoundaries: GitBoundary[] = [];
  const repositories: RepositoryContext[] = [];
  const objectIds = new Set<string>();
  let reusedFiles = 0;
  let capturedFiles = 0;
  const metadataPaths = new Set<string>();
  const contexts = new Map<string, RepositoryContext>();
  const unavailable = new Map<string, string>();
  const discover = (directory: string, relativeDirectory: string): void => {
    if (existsSync(join(directory, ".git"))) {
      for (const path of repositoryMetadata(root, relativeDirectory)
        .metadataPaths)
        metadataPaths.add(path);
      if (config.syncPolicy.mode === "default-branch") {
        try {
          contexts.set(
            relativeDirectory,
            inspectRepositoryContext(root, relativeDirectory),
          );
        } catch (error) {
          if (scoped === undefined) throw error;
          unavailable.set(
            relativeDirectory,
            error instanceof Error
              ? error.message
              : "Repository context is unavailable",
          );
        }
      }
    }
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (
        !child.isDirectory() ||
        child.isSymbolicLink() ||
        child.name === ".git"
      )
        continue;
      const path = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const target = join(directory, child.name);
      if (metadataPaths.has(target) || ignore.ignores(path, true)) continue;
      if (lstatSync(target).dev !== rootStat.dev)
        throw new Error(`Nested mount is unsupported: ${path}`);
      discover(target, path);
    }
  };
  discover(root, "");
  const scope: RepositoryScope | null =
    scoped === undefined
      ? null
      : (scoped.scope ??
        repositoryScope(config, contexts, unavailable, scoped));
  const eligibleContexts =
    scope === null
      ? contexts
      : new Map(scope.active.map((value) => [value.path, value]));

  const walk = (directory: string, relativeDirectory: string) => {
    const context = eligibleContexts.get(relativeDirectory);
    if (context !== undefined) {
      if (config.syncPolicy.mode === "default-branch") {
        if (
          context.branch !== config.syncPolicy.branch ||
          context.head === null
        )
          throw new Error(
            "Repository is not on the configured default branch; synchronization is paused",
          );
        repositories.push(context);
      }
    }
    const names = new Set<string>();
    for (const directoryEntry of readdirSync(directory, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = relativeDirectory
        ? `${relativeDirectory}/${directoryEntry.name}`
        : directoryEntry.name;
      normalizeRelativePath(path);
      if (path === ".codefoldersyncignore") continue;
      const target = join(directory, directoryEntry.name);
      if (metadataPaths.has(target)) continue;
      const stat = lstatSync(target);
      const directoryKind = stat.isDirectory() && !stat.isSymbolicLink();
      if (ignore.ignores(path, directoryKind)) continue;
      if (directoryEntry.name === ".git") continue;
      if (!directoryKind && scope !== null && !scopeIncludes(scope, path))
        continue;
      if (
        directoryKind &&
        scope !== null &&
        !scopeIncludes(scope, path) &&
        !scope.active.some((value) => value.path.startsWith(`${path}/`))
      )
        continue;
      if (!directoryKind && !policyIncludes(config.syncPolicy, path)) continue;
      const alias = portableName(directoryEntry.name);
      if (names.has(alias))
        throw new Error(
          `Portable name collision below ${relativeDirectory || "/"}`,
        );
      names.add(alias);
      if (stat.dev !== rootStat.dev)
        throw new Error(`Nested mount is unsupported: ${path}`);
      const exact = byPath.get(path);
      const identities = byIdentity.get(`${stat.dev}:${stat.ino}`) ?? [];
      const moved = identities.find((entry) => !claimed.has(entry.nodeId));
      const inherited =
        trustBaselinePaths ||
        (exact?.device === stat.dev && exact.inode === stat.ino)
          ? exact
          : moved;
      if (inherited !== undefined) claimed.add(inherited.nodeId);
      const kind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "regular"
            : null;
      if (kind === null)
        throw new Error(`Unsupported filesystem object: ${path}`);
      const reusable =
        !forceHash &&
        inherited !== undefined &&
        inherited.kind === kind &&
        inherited.manifestId !== null &&
        inherited.size === stat.size &&
        inherited.mtimeMs === stat.mtimeMs &&
        inherited.ctimeMs === stat.ctimeMs &&
        inherited.executable ===
          (kind === "regular" && (stat.mode & 0o111) !== 0);
      const captured =
        kind === "directory"
          ? null
          : reusable
            ? {
                manifestId: inherited.manifestId,
                objectIds: referencedObjects(inherited.manifestId, store),
              }
            : capturePath(target, store);
      if (kind !== "directory") {
        if (reusable) reusedFiles += 1;
        else capturedFiles += 1;
        for (const id of captured?.objectIds ?? []) objectIds.add(id);
      }
      const nodeId = inherited?.nodeId ?? randomUUID();
      const parentNodeId = relativeDirectory
        ? nodeByPath.get(relativeDirectory)
        : "$root";
      if (parentNodeId === undefined)
        throw new Error(`Catalog parent was not discovered: ${path}`);
      entries.push({
        path,
        parentPath: relativeDirectory || null,
        parentNodeId,
        name: directoryEntry.name,
        portableName: alias,
        nodeId,
        kind,
        manifestId: captured?.manifestId ?? null,
        executable: kind === "regular" && (stat.mode & 0o111) !== 0,
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
      nodeByPath.set(path, nodeId);
      if (kind === "directory") walk(target, path);
    }
  };
  walk(root, "");
  const includedLeaves = entries.filter((entry) => entry.kind !== "directory");
  const includedParents = new Set<string>();
  for (const entry of includedLeaves) {
    let parent = entry.parentPath;
    while (parent !== null) {
      includedParents.add(parent);
      const next = dirname(parent);
      parent = next === "." ? null : next;
    }
  }
  const selectedPolicy = config.syncPolicy;
  const includedEntries = entries.filter(
    (entry) =>
      entry.kind !== "directory" ||
      includedParents.has(entry.path) ||
      (policyIncludesDirectory(selectedPolicy, entry.path) &&
        (scope === null || scopeIncludes(scope, entry.path)) &&
        (readdirSync(join(root, entry.path)).length === 0 ||
          logicalEmptyDirectories.has(entry.path))),
  );
  includedEntries.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  gitBoundaries.sort((left, right) =>
    left.worktreePath.localeCompare(right.worktreePath, "en"),
  );
  repositories.sort((left, right) => left.path.localeCompare(right.path, "en"));
  // A checkout during capture invalidates the proposal, even if its bytes hashed.
  for (const context of repositories)
    assertMatchingRepositoryContext(
      config.syncPolicy,
      inspectRepositoryContext(root, context.path),
      context,
    );
  for (const context of scope?.guards ?? [])
    assertStableRepositoryContext(
      inspectRepositoryContext(root, context.path),
      context,
    );
  const digest = semanticDigest(
    includedEntries,
    gitBoundaries,
    ignore.digest,
    repositories,
  );
  return {
    manifest: {
      schemaVersion,
      folderId: config.folderId,
      ignoreDigest: ignore.digest,
      entries: includedEntries,
      gitBoundaries,
      repositories,
      createdAt: new Date().toISOString(),
      digest,
    },
    objectIds: [...objectIds],
    reusedFiles,
    capturedFiles,
    scope,
  };
}

function repositoryScope(
  config: ProductConfig,
  contexts: ReadonlyMap<string, RepositoryContext>,
  unavailable: ReadonlyMap<string, string>,
  options: RepositoryScanOptions,
): RepositoryScope {
  const accepted = new Map(
    options.accepted.repositories.map((value) => [value.path, value]),
  );
  const baseline = new Map(
    options.baseline?.repositories.map((value) => [value.path, value]) ?? [],
  );
  const paths = [
    ...new Set([
      ...contexts.keys(),
      ...unavailable.keys(),
      ...accepted.keys(),
      ...baseline.keys(),
    ]),
  ].sort();
  const active: RepositoryContext[] = [];
  const paused: { path: string; reason: string }[] = [];
  for (const path of paths) {
    const local = contexts.get(path);
    const remote = accepted.get(path);
    try {
      if (local === undefined)
        throw new Error(
          unavailable.get(path) ??
            "Repository is missing locally; synchronization is paused",
        );
      if (remote === undefined)
        throw new Error(
          "Repository is not enrolled in the accepted context; synchronization is paused",
        );
      assertMatchingRepositoryContext(config.syncPolicy, local, remote);
      const previous = baseline.get(path);
      if (previous === undefined)
        throw new Error(
          "Repository has no local context baseline; synchronization is paused",
        );
      assertMatchingRepositoryContext(config.syncPolicy, local, previous);
      active.push(local);
    } catch (error) {
      paused.push({
        path,
        reason:
          error instanceof Error
            ? error.message
            : "Repository synchronization is paused",
      });
    }
  }
  const eligible = active.filter((context) => {
    const unavailableParent = paths.find(
      (parent) =>
        parent !== context.path &&
        (parent === "" || context.path.startsWith(`${parent}/`)) &&
        !contexts.has(parent),
    );
    if (unavailableParent === undefined) return true;
    paused.push({
      path: context.path,
      reason:
        "An enclosing repository has unavailable or mutating Git state; synchronization is paused",
    });
    return false;
  });
  const guards = [...contexts.values()].filter((context) =>
    eligible.some(
      (child) =>
        context.path !== child.path &&
        (context.path === "" || child.path.startsWith(`${context.path}/`)),
    ),
  );
  return { paths, active: eligible, guards, paused };
}

/** A nested repository owns its paths independently of its enclosing checkout. */
export function scopeIncludes(scope: RepositoryScope, path: string): boolean {
  let lookup = scopeLookups.get(scope);
  if (lookup === undefined) {
    lookup = {
      paths: [...scope.paths].sort((left, right) => right.length - left.length),
      active: new Set(scope.active.map((value) => value.path)),
    };
    scopeLookups.set(scope, lookup);
  }
  const owner = lookup.paths.find(
    (root) => root === "" || path === root || path.startsWith(`${root}/`),
  );
  return owner === undefined || lookup.active.has(owner);
}

export function projectNamespace(
  manifest: NamespaceManifest,
  scope: RepositoryScope,
): NamespaceManifest {
  const selected = manifest.entries.filter((entry) =>
    scopeIncludes(scope, entry.path),
  );
  const entries = retainParents(selected, manifest.entries);
  const repositories = manifest.repositories.filter((value) =>
    scope.active.some((active) => active.path === value.path),
  );
  return {
    ...manifest,
    entries,
    repositories,
    digest: semanticDigest(entries, [], manifest.ignoreDigest, repositories),
  };
}

/** Keep suspended data from the reference; never turn an omitted repo into deletes. */
export function combineScopedNamespace(
  active: NamespaceManifest,
  reference: NamespaceManifest,
  scope: RepositoryScope,
): NamespaceManifest {
  const activeEntries = active.entries.filter((entry) =>
    scopeIncludes(scope, entry.path),
  );
  const held = reference.entries.filter(
    (entry) => !scopeIncludes(scope, entry.path),
  );
  const entries = retainParents(
    [...activeEntries, ...held],
    [...reference.entries, ...active.entries],
  );
  const repositories = [
    ...active.repositories,
    ...reference.repositories.filter(
      (value) => !scope.active.some((active) => active.path === value.path),
    ),
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const result = {
    ...active,
    entries,
    repositories,
    digest: semanticDigest(entries, [], active.ignoreDigest, repositories),
  };
  validateNamespaceManifest(result);
  return result;
}

function retainParents(
  selected: readonly CatalogEntry[],
  candidates: readonly CatalogEntry[],
): readonly CatalogEntry[] {
  const entries = new Map(selected.map((entry) => [entry.path, entry]));
  const byPath = new Map(candidates.map((entry) => [entry.path, entry]));
  for (const entry of selected) {
    let parent = entry.parentPath;
    while (parent !== null) {
      const value = entries.get(parent) ?? byPath.get(parent);
      if (value === undefined || value.kind !== "directory")
        throw new Error("Scoped namespace is missing a physical parent");
      entries.set(parent, value);
      parent = value.parentPath;
    }
  }
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      parentNodeId:
        entry.parentPath === null
          ? "$root"
          : (entries.get(entry.parentPath)?.nodeId ?? "$missing"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function semanticDigest(
  entries: readonly CatalogEntry[],
  gitBoundaries: readonly GitBoundary[],
  ignoreDigest: string,
  repositories: readonly RepositoryContext[] = [],
): string {
  return hashJson({
    ignoreDigest,
    repositories,
    entries: entries.map((entry) => ({
      path: entry.path,
      nodeId: entry.nodeId,
      parentNodeId: entry.parentNodeId,
      kind: entry.kind,
      manifestId: entry.manifestId,
      executable: entry.executable,
    })),
    gitBoundaries: gitBoundaries.map((boundary) => ({
      boundaryId: boundary.boundaryId,
      worktreePath: boundary.worktreePath,
      gitPath: boundary.gitPath,
      kind: boundary.kind,
      manifestId: boundary.manifestId,
    })),
  });
}

export function validateNamespaceManifest(manifest: NamespaceManifest): void {
  if (manifest.schemaVersion !== schemaVersion)
    throw new Error("Snapshot is not CodeFolderSync V3");
  if (!Array.isArray(manifest.repositories))
    throw new Error("Snapshot has no repository context contract");
  const repositoryPaths = new Set<string>();
  for (const repository of manifest.repositories) {
    if (repository.path !== "") normalizeRelativePath(repository.path);
    assertHash(repository.identity, "Repository identity");
    if (
      repositoryPaths.has(repository.path) ||
      (repository.branch !== null && typeof repository.branch !== "string") ||
      (repository.head !== null &&
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repository.head))
    )
      throw new Error("Snapshot repository context is invalid");
    repositoryPaths.add(repository.path);
  }
  const paths = new Set<string>();
  const nodes = new Set<string>();
  const aliases = new Set<string>();
  const entriesByPath = new Map<string, CatalogEntry>();
  for (const entry of manifest.entries) {
    normalizeRelativePath(entry.path);
    if (entry.nodeId.length === 0)
      throw new Error(`Snapshot node ID is empty: ${entry.path}`);
    const parts = entry.path.split("/");
    const expectedName = parts.at(-1);
    const expectedParent =
      parts.length === 1 ? null : parts.slice(0, -1).join("/");
    if (
      entry.name !== expectedName ||
      entry.parentPath !== expectedParent ||
      entry.portableName !== portableName(entry.name)
    )
      throw new Error(`Snapshot path metadata is inconsistent: ${entry.path}`);
    const expectedParentNode =
      expectedParent === null
        ? "$root"
        : entriesByPath.get(expectedParent)?.nodeId;
    if (entry.parentNodeId !== expectedParentNode)
      throw new Error(
        `Snapshot parent identity is inconsistent: ${entry.path}`,
      );
    if (
      (entry.kind === "directory" && entry.manifestId !== null) ||
      (entry.kind !== "directory" && entry.manifestId === null)
    )
      throw new Error(`Snapshot manifest binding is invalid: ${entry.path}`);
    if (entry.manifestId !== null)
      assertHash(entry.manifestId, "Snapshot manifest ID");
    if (paths.has(entry.path)) throw new Error(`Duplicate path: ${entry.path}`);
    if (nodes.has(entry.nodeId))
      throw new Error(`Duplicate node identity: ${entry.nodeId}`);
    const alias = `${entry.parentPath ?? ""}/${entry.portableName}`;
    if (aliases.has(alias))
      throw new Error(`Portable alias collision: ${entry.path}`);
    if (entry.parentPath !== null && !paths.has(entry.parentPath))
      throw new Error(`Snapshot parent precedes no directory: ${entry.path}`);
    if (
      entry.parentPath !== null &&
      entriesByPath.get(entry.parentPath)?.kind !== "directory"
    )
      throw new Error(`Snapshot parent is not a directory: ${entry.path}`);
    paths.add(entry.path);
    nodes.add(entry.nodeId);
    aliases.add(alias);
    entriesByPath.set(entry.path, entry);
  }
  const boundaryIds = new Set<string>();
  const worktrees = new Set<string>();
  for (const boundary of manifest.gitBoundaries) {
    assertHash(boundary.boundaryId, "Git boundary ID");
    assertHash(boundary.manifestId, "Git boundary manifest ID");
    if (boundary.worktreePath !== "")
      normalizeRelativePath(boundary.worktreePath);
    normalizeRelativePath(boundary.gitPath);
    if (
      boundaryIds.has(boundary.boundaryId) ||
      worktrees.has(boundary.worktreePath)
    )
      throw new Error(`Duplicate Git boundary: ${boundary.worktreePath}`);
    boundaryIds.add(boundary.boundaryId);
    worktrees.add(boundary.worktreePath);
  }
  if (
    semanticDigest(
      manifest.entries,
      manifest.gitBoundaries,
      manifest.ignoreDigest,
      manifest.repositories,
    ) !== manifest.digest
  )
    throw new Error("Snapshot semantic digest is invalid");
}

export function validateNamespacePolicy(
  manifest: NamespaceManifest,
  config: ProductConfig,
): void {
  validateNamespaceManifest(manifest);
  const leaves = manifest.entries.filter((entry) => entry.kind !== "directory");
  for (const entry of manifest.entries) {
    if (
      !policyIncludes(config.syncPolicy, entry.path) &&
      !(
        entry.kind === "directory" &&
        (policyIncludesDirectory(config.syncPolicy, entry.path) ||
          leaves.some(
            (leaf) =>
              leaf.path.startsWith(`${entry.path}/`) &&
              policyIncludes(config.syncPolicy, leaf.path),
          ))
      )
    )
      throw new Error(
        "Snapshot contains a path outside the signed synchronization policy",
      );
  }
  if (manifest.gitBoundaries.length !== 0)
    throw new Error(
      "Git metadata is not part of either synchronization policy",
    );
  if (
    config.syncPolicy.mode === "selected-files" &&
    manifest.repositories.length !== 0
  )
    throw new Error("Selected-files snapshots must not couple local Git state");
  if (config.syncPolicy.mode === "default-branch") {
    const branch = config.syncPolicy.branch;
    if (
      manifest.repositories.some(
        (repository) =>
          repository.branch !== branch || repository.head === null,
      )
    )
      throw new Error(
        "Default-branch snapshot contains an ineligible repository",
      );
  }
}

export function manifestObjectIds(
  manifest: NamespaceManifest,
  store: ObjectStore,
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of manifest.entries)
    if (entry.manifestId !== null)
      for (const id of referencedObjects(entry.manifestId, store)) ids.add(id);
  for (const boundary of manifest.gitBoundaries)
    for (const id of referencedObjects(boundary.manifestId, store)) ids.add(id);
  return [...ids];
}

function captureGitBoundary(
  root: string,
  worktreeDirectory: string,
  gitEntry: string,
  gitRelativePath: string,
  store: ObjectStore,
  objectIds: Set<string>,
): GitBoundary {
  const stat = lstatSync(gitEntry);
  const worktreePath = relative(root, worktreeDirectory).replaceAll(sep, "/");
  let physical = gitEntry;
  let kind: GitBoundary["kind"] = "physical";
  if (stat.isFile() && !stat.isSymbolicLink()) {
    const content = readFileSync(gitEntry, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/u.exec(content);
    if (match?.[1] === undefined)
      throw new Error(`Malformed Git indirection: ${gitRelativePath}`);
    physical = resolve(worktreeDirectory, match[1]);
    const absoluteRoot = resolve(root);
    if (
      physical !== absoluteRoot &&
      !physical.startsWith(`${absoluteRoot}${sep}`)
    )
      throw new Error(
        `External Git directory is unsupported: ${gitRelativePath}`,
      );
    kind = physical.includes(`${sep}.git${sep}modules${sep}`)
      ? "submodule"
      : "indirection";
  } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsupported .git boundary: ${gitRelativePath}`);
  }
  if (!existsSync(physical) || !lstatSync(physical).isDirectory())
    throw new Error(`Git directory is missing: ${gitRelativePath}`);
  verifyGitDirectory(physical);
  const captured = captureGitTree(physical, store);
  for (const id of captured.objectIds) objectIds.add(id);
  const gitPath = relative(root, physical).replaceAll(sep, "/");
  return {
    boundaryId: hashText(`${worktreePath}\0${gitPath}`),
    worktreePath,
    gitPath,
    kind,
    manifestId: captured.manifestId,
  };
}

function verifyGitDirectory(path: string): void {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", `--git-dir=${path}`, "fsck", "--full"],
    { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (result.status !== 0)
    throw new Error(`Git verification failed: ${result.stderr.trim()}`);
}
