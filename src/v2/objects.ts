import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { canonicalJson, hashBytes, hashJson, assertHash } from "./hash.js";
import {
  assertRealDirectoryAncestors,
  normalizeRelativePath,
} from "./paths.js";
import {
  schemaVersion,
  type ChunkRef,
  type ContentManifest,
  type NodeKind,
  type ObjectEncoding,
  type RegularManifest,
  type StoredObject,
  type SymlinkManifest,
  type TreeManifest,
  type TreeManifestEntry,
} from "./types.js";

const smallFileCutoff = 64 * 1024;
const minimumChunk = 256 * 1024;
const averageMask = (1 << 20) - 1;
const maximumChunk = 4 * 1024 * 1024;
const readBufferBytes = 1024 * 1024;
const gear = createGearTable();

export class ObjectStore implements Disposable {
  public readonly root: string;
  private readonly database: DatabaseSync;
  private batchDepth = 0;

  public constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(this.root, "objects.sqlite"));
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        bytes BLOB NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  public [Symbol.dispose](): void {
    this.database.close();
  }

  public has(id: string): boolean {
    assertHash(id, "Object ID");
    return (
      this.database.prepare("SELECT 1 FROM objects WHERE id = ?").get(id) !==
      undefined
    );
  }

  public get(id: string): Buffer {
    assertHash(id, "Object ID");
    const row = this.database
      .prepare("SELECT bytes FROM objects WHERE id = ?")
      .get(id) as { readonly bytes?: unknown } | undefined;
    if (row === undefined || !(row.bytes instanceof Uint8Array))
      throw new Error(`Missing object: ${id}`);
    const bytes = Buffer.from(row.bytes);
    if (hashBytes(bytes) !== id) throw new Error(`Corrupt object: ${id}`);
    return bytes;
  }

  public put(bytes: Buffer, expectedId = hashBytes(bytes)): string {
    assertHash(expectedId, "Object ID");
    if (hashBytes(bytes) !== expectedId)
      throw new Error(`Object digest mismatch: ${expectedId}`);
    if (this.has(expectedId)) {
      if (hashBytes(this.get(expectedId)) !== expectedId)
        throw new Error(`Existing object is corrupt: ${expectedId}`);
      return expectedId;
    }
    this.database
      .prepare("INSERT OR IGNORE INTO objects(id, bytes) VALUES (?, ?)")
      .run(expectedId, bytes);
    return expectedId;
  }

  /** Groups a bulk capture or transfer into one durable SQLite commit. */
  public batch<T>(action: () => T): T {
    if (this.batchDepth > 0) return action();
    this.batchDepth += 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.batchDepth -= 1;
    }
  }

  public putJson(value: unknown): string {
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    return this.put(bytes);
  }

  public getManifest(id: string): ContentManifest {
    let value: unknown;
    try {
      value = JSON.parse(this.get(id).toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid manifest ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const manifest = parseManifest(value);
    if (hashJson(manifest) !== id)
      throw new Error(`Manifest ID mismatch: ${id}`);
    return manifest;
  }

  public object(id: string): StoredObject {
    return { id, bytes: this.get(id) };
  }

  public listIds(): readonly string[] {
    return this.database
      .prepare("SELECT id FROM objects ORDER BY id")
      .all()
      .map((row) => String((row as { readonly id: unknown }).id));
  }

  public size(id: string): number {
    assertHash(id, "Object ID");
    const row = this.database
      .prepare("SELECT length(bytes) AS bytes FROM objects WHERE id = ?")
      .get(id) as { readonly bytes?: unknown } | undefined;
    if (row === undefined || typeof row.bytes !== "number")
      throw new Error(`Missing object: ${id}`);
    return row.bytes;
  }
}

export interface CaptureResult {
  readonly kind: NodeKind;
  readonly manifestId: string | null;
  readonly objectIds: readonly string[];
  readonly device: number;
  readonly inode: number;
}

export function capturePath(path: string, store: ObjectStore): CaptureResult {
  const before = lstatSync(path);
  if (before.isDirectory()) {
    return {
      kind: "directory",
      manifestId: null,
      objectIds: [],
      device: before.dev,
      inode: before.ino,
    };
  }
  if (before.isSymbolicLink()) {
    const target = readlinkSync(path, { encoding: "utf8" });
    const digest = hashBytes(Buffer.from(target, "utf8"));
    const manifest: SymlinkManifest = {
      schemaVersion,
      type: "symlink",
      target,
      digest,
    };
    const manifestId = store.putJson(manifest);
    const after = lstatSync(path);
    assertStable(before, after, path);
    return {
      kind: "symlink",
      manifestId,
      objectIds: [manifestId],
      device: before.dev,
      inode: before.ino,
    };
  }
  if (!before.isFile())
    throw new Error(`Unsupported filesystem object: ${path}`);
  const captured = captureRegular(path, store, before.size, before.mode);
  const after = lstatSync(path);
  assertStable(before, after, path);
  return {
    kind: "regular",
    manifestId: captured.manifestId,
    objectIds: captured.objectIds,
    device: before.dev,
    inode: before.ino,
  };
}

export function captureTree(
  path: string,
  store: ObjectStore,
): {
  readonly manifestId: string;
  readonly objectIds: readonly string[];
} {
  const seen = new Set<string>();
  const result = captureTreeDirectory(resolve(path), store, seen);
  return { manifestId: result, objectIds: [...seen] };
}

export function referencedObjects(
  manifestId: string,
  store: ObjectStore,
): readonly string[] {
  const result = new Set<string>();
  collectReferenced(manifestId, store, result);
  return [...result];
}

export function materializeManifest(
  manifestId: string,
  destination: string,
  store: ObjectStore,
  durable = true,
): void {
  const manifest = store.getManifest(manifestId);
  if (manifest.type === "tree") {
    if (existsSync(destination))
      throw new Error(`Destination exists: ${destination}`);
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    materializeTreeEntries(manifest, destination, store, durable);
    if (durable) fsyncTree(destination);
    return;
  }
  materializeLeaf(manifest, destination, store, durable);
}

export function encodeTransfer(bytes: Buffer): {
  readonly encoding: ObjectEncoding;
  readonly payload: Buffer;
} {
  if (bytes.length < 1024) return { encoding: "raw", payload: bytes };
  const compressed = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 3 },
  });
  return compressed.length + 32 < bytes.length
    ? { encoding: "brotli", payload: compressed }
    : { encoding: "raw", payload: bytes };
}

export function decodeTransfer(
  encoding: ObjectEncoding,
  payload: Buffer,
): Buffer {
  return encoding === "brotli" ? brotliDecompressSync(payload) : payload;
}

export function parseManifest(value: unknown): ContentManifest {
  const input = record(value, "Manifest");
  if (input.schemaVersion !== schemaVersion)
    throw new Error("Unsupported manifest version");
  if (input.type === "regular") {
    const chunksValue = input.chunks;
    if (!Array.isArray(chunksValue)) throw new Error("Invalid manifest chunks");
    const chunks: ChunkRef[] = chunksValue.map((value, index) => {
      const chunk = record(value, `Chunk ${index}`);
      const id = string(chunk.id, "Chunk ID");
      assertHash(id, "Chunk ID");
      return { id, bytes: integer(chunk.bytes, "Chunk bytes") };
    });
    const digest = string(input.digest, "Manifest digest");
    assertHash(digest, "Manifest digest");
    const manifest: RegularManifest = {
      schemaVersion,
      type: "regular",
      executable: boolean(input.executable, "Executable"),
      bytes: integer(input.bytes, "Manifest bytes"),
      digest,
      chunks,
    };
    if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== manifest.bytes)
      throw new Error("Manifest chunk size mismatch");
    return manifest;
  }
  if (input.type === "symlink") {
    const target = stringAllowEmpty(input.target, "Symlink target");
    const digest = string(input.digest, "Symlink digest");
    assertHash(digest, "Symlink digest");
    if (hashBytes(Buffer.from(target, "utf8")) !== digest)
      throw new Error("Symlink digest mismatch");
    return { schemaVersion, type: "symlink", target, digest };
  }
  if (input.type === "tree") {
    if (!Array.isArray(input.entries)) throw new Error("Invalid tree entries");
    const entries = input.entries.map((value, index) => {
      const entry = record(value, `Tree entry ${index}`);
      const name = string(entry.name, "Tree entry name");
      if (name.includes("/") || name === "." || name === "..")
        throw new Error(`Invalid tree entry name: ${name}`);
      const kind = nodeKind(entry.kind);
      const rawManifestId = entry.manifestId;
      if (rawManifestId !== null && typeof rawManifestId !== "string")
        throw new Error("Invalid tree entry manifest ID");
      if (typeof rawManifestId === "string") assertHash(rawManifestId);
      if (kind !== "directory" && rawManifestId === null)
        throw new Error("Tree leaf manifest is missing");
      return { name, kind, manifestId: rawManifestId };
    });
    const sorted = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    if (JSON.stringify(entries) !== JSON.stringify(sorted))
      throw new Error("Tree entries are not sorted");
    const digest = string(input.digest, "Tree digest");
    assertHash(digest, "Tree digest");
    if (hashJson(entries) !== digest) throw new Error("Tree digest mismatch");
    return { schemaVersion, type: "tree", entries, digest };
  }
  throw new Error("Unknown manifest type");
}

function captureRegular(
  path: string,
  store: ObjectStore,
  size: number,
  mode: number,
): { readonly manifestId: string; readonly objectIds: readonly string[] } {
  const chunks: ChunkRef[] = [];
  const objectIds = new Set<string>();
  const whole = createHash("sha256");
  if (size <= smallFileCutoff) {
    const bytes = readFileSync(path);
    whole.update(bytes);
    const id = store.put(bytes);
    chunks.push({ id, bytes: bytes.length });
    objectIds.add(id);
  } else {
    forEachChunk(path, (bytes) => {
      whole.update(bytes);
      const id = hashBytes(bytes);
      if (!objectIds.has(id)) store.put(bytes, id);
      chunks.push({ id, bytes: bytes.length });
      objectIds.add(id);
    });
  }
  const manifest: RegularManifest = {
    schemaVersion,
    type: "regular",
    executable: (mode & 0o111) !== 0,
    bytes: size,
    digest: whole.digest("hex"),
    chunks,
  };
  const manifestId = store.putJson(manifest);
  objectIds.add(manifestId);
  return { manifestId, objectIds: [...objectIds] };
}

function forEachChunk(path: string, consume: (bytes: Buffer) => void): void {
  const descriptor = openSync(path, "r");
  const input = Buffer.allocUnsafe(readBufferBytes);
  const chunk = Buffer.allocUnsafe(maximumChunk);
  let chunkBytes = 0;
  let rolling = 0;
  const flush = () => {
    if (chunkBytes === 0) return;
    // Consumers are synchronous, so the same bounded buffer can be reused for
    // the whole file without retaining a file-sized trail of temporary Buffers.
    consume(chunk.subarray(0, chunkBytes));
    chunkBytes = 0;
    rolling = 0;
  };
  try {
    for (;;) {
      const count = readSync(descriptor, input, 0, input.length, null);
      if (count === 0) break;
      for (let index = 0; index < count; index += 1) {
        const byte = input[index];
        if (byte === undefined) throw new Error("Chunk read failed");
        chunk[chunkBytes] = byte;
        chunkBytes += 1;
        rolling = ((rolling << 1) + (gear[byte] ?? 0)) >>> 0;
        if (
          chunkBytes >= maximumChunk ||
          (chunkBytes >= minimumChunk && (rolling & averageMask) === 0)
        ) {
          flush();
        }
      }
    }
    flush();
  } finally {
    closeSync(descriptor);
  }
}

function captureTreeDirectory(
  path: string,
  store: ObjectStore,
  seen: Set<string>,
): string {
  const entries: TreeManifestEntry[] = [];
  const names = readdirSync(path).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  for (const name of names) {
    if (name.endsWith(".lock"))
      throw new Error(
        `Transient Git lock prevents capture: ${join(path, name)}`,
      );
    normalizeRelativePath(name);
    const target = join(path, name);
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      const manifestId = captureTreeDirectory(target, store, seen);
      entries.push({ name, kind: "directory", manifestId });
      continue;
    }
    const captured = capturePath(target, store);
    if (captured.kind === "directory") throw new Error("Unexpected directory");
    for (const id of captured.objectIds) seen.add(id);
    entries.push({
      name,
      kind: captured.kind,
      manifestId: captured.manifestId,
    });
  }
  const manifest: TreeManifest = {
    schemaVersion,
    type: "tree",
    entries,
    digest: hashJson(entries),
  };
  const manifestId = store.putJson(manifest);
  seen.add(manifestId);
  return manifestId;
}

function collectReferenced(
  manifestId: string,
  store: ObjectStore,
  result: Set<string>,
): void {
  if (result.has(manifestId)) return;
  result.add(manifestId);
  const manifest = store.getManifest(manifestId);
  if (manifest.type === "regular") {
    for (const chunk of manifest.chunks) result.add(chunk.id);
  } else if (manifest.type === "tree") {
    for (const entry of manifest.entries) {
      if (entry.manifestId !== null)
        collectReferenced(entry.manifestId, store, result);
    }
  }
}

function materializeLeaf(
  manifest: RegularManifest | SymlinkManifest,
  destination: string,
  store: ObjectStore,
  durable = true,
): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  assertRealDirectoryAncestors(findExistingRoot(destination), destination);
  const temporary = join(
    dirname(destination),
    `.codefoldersync-apply-${randomUUID()}`,
  );
  if (manifest.type === "symlink") {
    symlinkSync(manifest.target, temporary);
    renameSync(temporary, destination);
    if (durable) fsyncPath(dirname(destination));
    return;
  }
  const descriptor = openSync(
    temporary,
    "wx",
    manifest.executable ? 0o755 : 0o644,
  );
  const whole = createHash("sha256");
  let bytes = 0;
  try {
    for (const chunk of manifest.chunks) {
      const value = store.get(chunk.id);
      if (value.length !== chunk.bytes)
        throw new Error(`Chunk length mismatch: ${chunk.id}`);
      writeSync(descriptor, value);
      whole.update(value);
      bytes += value.length;
    }
    if (durable) fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (bytes !== manifest.bytes || whole.digest("hex") !== manifest.digest) {
    unlinkSync(temporary);
    throw new Error("Materialized file digest mismatch");
  }
  chmodSync(temporary, manifest.executable ? 0o755 : 0o644);
  renameSync(temporary, destination);
  if (durable) fsyncPath(dirname(destination));
}

function materializeTreeEntries(
  tree: TreeManifest,
  root: string,
  store: ObjectStore,
  durable: boolean,
): void {
  for (const entry of tree.entries) {
    const target = join(root, entry.name);
    if (entry.kind === "directory") {
      if (entry.manifestId === null)
        throw new Error("Tree directory is missing");
      mkdirSync(target, { recursive: false, mode: 0o700 });
      const child = store.getManifest(entry.manifestId);
      if (child.type !== "tree")
        throw new Error("Tree child is not a directory");
      materializeTreeEntries(child, target, store, durable);
      continue;
    }
    if (entry.manifestId === null) throw new Error("Tree leaf is missing");
    const child = store.getManifest(entry.manifestId);
    if (child.type === "tree") throw new Error("Tree leaf is a directory");
    materializeLeaf(child, target, store, durable);
  }
}

function fsyncTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) fsyncTree(join(path, entry.name));
  }
  fsyncPath(path);
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function findExistingRoot(path: string): string {
  let cursor = dirname(resolve(path));
  while (!existsSync(cursor)) cursor = dirname(cursor);
  return cursor;
}

function assertStable(before: Stats, after: Stats, path: string): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.mode !== after.mode
  ) {
    throw new Error(`Path changed during capture: ${path}`);
  }
}

function createGearTable(): Uint32Array {
  const result = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state >>> 0;
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function nodeKind(value: unknown): NodeKind {
  if (value === "directory" || value === "regular" || value === "symlink")
    return value;
  throw new Error("Invalid node kind");
}
