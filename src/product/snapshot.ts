import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fsyncDirectory } from "./io.js";
import {
  productSchemaVersion,
  type Snapshot,
  type SnapshotFile,
} from "./types.js";
import {
  assertId,
  assertRelativeFilePath,
  assertSnapshotId,
  assertUnit,
  normalizedCollisionKey,
} from "./validation.js";

const transientGitLock = /(^|\/)\.git\/.*\.lock$/u;

export function captureSnapshot(input: {
  readonly folderId: string;
  readonly unit: string;
  readonly unitPath: string;
  readonly parentId: string | null;
  readonly peerId: string;
}): Snapshot {
  const first = scanUnit(input.unitPath);
  const second = scanUnit(input.unitPath);
  if (first.treeDigest !== second.treeDigest) {
    throw new Error(`Repository changed while scanning: ${input.unit}`);
  }
  return createSnapshot({
    folderId: input.folderId,
    unit: input.unit,
    parentId: input.parentId,
    peerId: input.peerId,
    files: second.files,
  });
}

export function createSnapshot(input: {
  readonly folderId: string;
  readonly unit: string;
  readonly parentId: string | null;
  readonly peerId: string;
  readonly files: readonly SnapshotFile[];
}): Snapshot {
  assertId(input.folderId, "Folder ID");
  assertId(input.peerId, "Peer ID");
  assertUnit(input.unit);
  if (input.parentId !== null) assertSnapshotId(input.parentId, "Parent ID");
  const files = [...input.files].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  validateFiles(files);
  const treeDigest = digestTree(files);
  const snapshotId = digestJson({
    schemaVersion: productSchemaVersion,
    folderId: input.folderId,
    unit: input.unit,
    parentId: input.parentId,
    peerId: input.peerId,
    treeDigest,
    files: files.map(({ path, digest, bytes, executable }) => ({
      path,
      digest,
      bytes,
      executable,
    })),
  });
  return {
    schemaVersion: productSchemaVersion,
    snapshotId,
    folderId: input.folderId,
    unit: input.unit,
    parentId: input.parentId,
    peerId: input.peerId,
    createdAt: new Date().toISOString(),
    treeDigest,
    files,
  };
}

export function validateSnapshot(snapshot: Snapshot): void {
  if (snapshot.schemaVersion !== productSchemaVersion) {
    throw new Error("Unsupported snapshot version");
  }
  assertSnapshotId(snapshot.snapshotId);
  assertId(snapshot.folderId, "Folder ID");
  assertId(snapshot.peerId, "Peer ID");
  assertUnit(snapshot.unit);
  if (snapshot.parentId !== null)
    assertSnapshotId(snapshot.parentId, "Parent ID");
  const files = [...snapshot.files].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  validateFiles(files);
  const treeDigest = digestTree(files);
  if (treeDigest !== snapshot.treeDigest)
    throw new Error("Snapshot tree digest mismatch");
  const expectedId = digestJson({
    schemaVersion: productSchemaVersion,
    folderId: snapshot.folderId,
    unit: snapshot.unit,
    parentId: snapshot.parentId,
    peerId: snapshot.peerId,
    treeDigest,
    files: files.map(({ path, digest, bytes, executable }) => ({
      path,
      digest,
      bytes,
      executable,
    })),
  });
  if (expectedId !== snapshot.snapshotId)
    throw new Error("Snapshot ID mismatch");
}

export function materializeSnapshot(
  snapshot: Snapshot,
  destination: string,
): void {
  validateSnapshot(snapshot);
  if (existsSync(destination))
    throw new Error(`Destination already exists: ${destination}`);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const root = resolve(destination);
  for (const file of snapshot.files) {
    const target = resolve(root, ...file.path.split("/"));
    if (!target.startsWith(`${root}${sep}`))
      throw new Error("Snapshot path escaped root");
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const content = Buffer.from(file.content, "base64");
    const descriptor = openSync(target, "wx", file.executable ? 0o755 : 0o644);
    try {
      writeSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(target, file.executable ? 0o755 : 0o644);
  }
  fsyncTree(destination);
  verifyGitRepository(destination);
  const actual = scanUnit(destination);
  if (actual.treeDigest !== snapshot.treeDigest) {
    throw new Error("Materialized snapshot failed digest validation");
  }
}

export function scanUnit(unitPath: string): {
  readonly treeDigest: string;
  readonly files: readonly SnapshotFile[];
} {
  const root = resolve(unitPath);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory())
    throw new Error(`Repository is not a directory: ${root}`);
  const gitPath = join(root, ".git");
  if (!existsSync(gitPath)) throw new Error(`Missing .git directory: ${root}`);
  if (!lstatSync(gitPath).isDirectory()) {
    throw new Error(`Linked worktrees are unsupported: ${root}`);
  }
  const files: SnapshotFile[] = [];
  walk(root, "", files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  validateFiles(files);
  return { treeDigest: digestTree(files), files };
}

export function verifyGitRepository(path: string): void {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-C", path, "fsck", "--full"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Git validation failed for ${path}: ${result.stderr.trim()}`,
    );
  }
}

function walk(root: string, relative: string, files: SnapshotFile[]): void {
  const directory =
    relative.length === 0 ? root : join(root, ...relative.split("/"));
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  )) {
    const relativePath =
      relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    assertRelativeFilePath(relativePath);
    const absolute = join(directory, entry.name);
    const before = lstatSync(absolute);
    if (before.isSymbolicLink())
      throw new Error(`Symlink is unsupported: ${relativePath}`);
    if (before.isDirectory()) {
      walk(root, relativePath, files);
      continue;
    }
    if (!before.isFile())
      throw new Error(`Special file is unsupported: ${relativePath}`);
    if (transientGitLock.test(relativePath)) {
      throw new Error(`Transient Git lock blocks capture: ${relativePath}`);
    }
    const content = readFileSync(absolute);
    const after = lstatSync(absolute);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new Error(`File changed while scanning: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      executable: (after.mode & 0o111) !== 0,
      content: content.toString("base64"),
    });
  }
}

function validateFiles(files: readonly SnapshotFile[]): void {
  const paths = new Set<string>();
  const collisions = new Set<string>();
  for (const file of files) {
    assertRelativeFilePath(file.path);
    if (paths.has(file.path))
      throw new Error(`Duplicate snapshot path: ${file.path}`);
    paths.add(file.path);
    const collision = normalizedCollisionKey(file.path);
    if (collisions.has(collision))
      throw new Error(`Case/Unicode path collision: ${file.path}`);
    collisions.add(collision);
    if (!/^[a-f0-9]{64}$/.test(file.digest))
      throw new Error("Invalid file digest");
    const content = Buffer.from(file.content, "base64");
    if (content.byteLength !== file.bytes)
      throw new Error(`Byte count mismatch: ${file.path}`);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== file.digest)
      throw new Error(`File digest mismatch: ${file.path}`);
  }
}

function digestTree(files: readonly SnapshotFile[]): string {
  return digestJson(
    files.map(({ path, digest, bytes, executable }) => ({
      path,
      digest,
      bytes,
      executable,
    })),
  );
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fsyncTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(absolute);
    } else if (entry.isFile()) {
      const descriptor = openSync(absolute, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }
  fsyncDirectory(path);
}
