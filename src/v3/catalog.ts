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
  schemaVersion,
  type CatalogEntry,
  type GitBoundary,
  type NamespaceManifest,
  type ProductConfig,
} from "./types.js";

export interface ScanResult {
  readonly manifest: NamespaceManifest;
  readonly objectIds: readonly string[];
  readonly reusedFiles: number;
  readonly capturedFiles: number;
}

export function scanNamespace(
  config: ProductConfig,
  store: ObjectStore,
  ignore: CompiledIgnore,
  baseline: readonly CatalogEntry[] = [],
  forceHash = false,
  trustBaselinePaths = false,
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
  const objectIds = new Set<string>();
  let reusedFiles = 0;
  let capturedFiles = 0;

  const walk = (directory: string, relativeDirectory: string) => {
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
      const stat = lstatSync(target);
      const directoryKind = stat.isDirectory() && !stat.isSymbolicLink();
      if (ignore.ignores(path, directoryKind)) continue;
      const alias = portableName(directoryEntry.name);
      if (names.has(alias))
        throw new Error(
          `Portable name collision below ${relativeDirectory || "/"}`,
        );
      names.add(alias);
      if (stat.dev !== rootStat.dev)
        throw new Error(`Nested mount is unsupported: ${path}`);
      if (directoryEntry.name === ".git") {
        gitBoundaries.push(
          captureGitBoundary(root, directory, target, path, store, objectIds),
        );
        continue;
      }
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
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  gitBoundaries.sort((left, right) =>
    left.worktreePath.localeCompare(right.worktreePath, "en"),
  );
  const digest = semanticDigest(entries, gitBoundaries, ignore.digest);
  return {
    manifest: {
      schemaVersion,
      folderId: config.folderId,
      ignoreDigest: ignore.digest,
      entries,
      gitBoundaries,
      createdAt: new Date().toISOString(),
      digest,
    },
    objectIds: [...objectIds],
    reusedFiles,
    capturedFiles,
  };
}

export function semanticDigest(
  entries: readonly CatalogEntry[],
  gitBoundaries: readonly GitBoundary[],
  ignoreDigest: string,
): string {
  return hashJson({
    ignoreDigest,
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
    ) !== manifest.digest
  )
    throw new Error("Snapshot semantic digest is invalid");
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
