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
import { dirname, join } from "node:path";
import { ObjectStore } from "../v2/objects.js";
import { assertHash, canonicalJson, hashBytes, hashJson } from "../v2/hash.js";
import { assertRealAncestors } from "./paths.js";
import {
  schemaVersion,
  type ContentManifest,
  type NodeKind,
  type RegularManifest,
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

export { ObjectStore };

export interface CaptureResult {
  readonly kind: NodeKind;
  readonly manifestId: string | null;
  readonly objectIds: readonly string[];
  readonly device: number;
  readonly inode: number;
}

export function capturePath(path: string, store: ObjectStore): CaptureResult {
  const before = lstatSync(path);
  if (before.isDirectory())
    return {
      kind: "directory",
      manifestId: null,
      objectIds: [],
      device: before.dev,
      inode: before.ino,
    };
  if (before.isSymbolicLink()) {
    const target = readlinkSync(path, "utf8");
    const manifest: SymlinkManifest = {
      schemaVersion,
      type: "symlink",
      target,
      digest: hashBytes(Buffer.from(target, "utf8")),
    };
    const manifestId = store.put(Buffer.from(canonicalJson(manifest), "utf8"));
    assertStable(before, lstatSync(path), path);
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
  const whole = createHash("sha256");
  const chunks: { readonly id: string; readonly bytes: number }[] = [];
  const objectIds: string[] = [];
  let bytes = 0;
  const consume = (chunk: Buffer) => {
    whole.update(chunk);
    const id = store.put(chunk);
    chunks.push({ id, bytes: chunk.length });
    objectIds.push(id);
    bytes += chunk.length;
  };
  if (before.size <= smallFileCutoff) consume(readFileSync(path));
  else forEachChunk(path, consume);
  const manifest: RegularManifest = {
    schemaVersion,
    type: "regular",
    executable: (before.mode & 0o111) !== 0,
    bytes,
    digest: whole.digest("hex"),
    chunks,
  };
  const manifestId = store.put(Buffer.from(canonicalJson(manifest), "utf8"));
  objectIds.push(manifestId);
  assertStable(before, lstatSync(path), path);
  return {
    kind: "regular",
    manifestId,
    objectIds,
    device: before.dev,
    inode: before.ino,
  };
}

export function captureTree(
  root: string,
  store: ObjectStore,
): { readonly manifestId: string; readonly objectIds: readonly string[] } {
  const objectIds = new Set<string>();
  const rootDevice = lstatSync(root).dev;
  const walk = (path: string): string => {
    const entries: TreeManifestEntry[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    )) {
      if (entry.name.endsWith(".lock"))
        throw new Error(`Transient Git lock cannot be captured: ${entry.name}`);
      const target = join(path, entry.name);
      const stat = lstatSync(target);
      if (stat.dev !== rootDevice)
        throw new Error(
          `Nested mount is unsupported in Git metadata: ${target}`,
        );
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({
          name: entry.name,
          kind: "directory",
          manifestId: walk(target),
        });
        continue;
      }
      const captured = capturePath(target, store);
      if (captured.kind === "directory")
        throw new Error(`Unexpected tree directory: ${target}`);
      for (const id of captured.objectIds) objectIds.add(id);
      entries.push({
        name: entry.name,
        kind: captured.kind,
        manifestId: captured.manifestId,
      });
    }
    const digest = hashJson(
      entries.map(({ name, kind, manifestId }) => ({ name, kind, manifestId })),
    );
    const manifest: TreeManifest = {
      schemaVersion,
      type: "tree",
      entries,
      digest,
    };
    const id = store.put(Buffer.from(canonicalJson(manifest), "utf8"));
    objectIds.add(id);
    return id;
  };
  const manifestId = walk(root);
  return { manifestId, objectIds: [...objectIds] };
}

export function parseManifest(bytes: Buffer): ContentManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Manifest is not valid JSON");
  }
  if (typeof value !== "object" || value === null)
    throw new Error("Manifest must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== schemaVersion)
    throw new Error("Manifest is not CodeFolderSync V3");
  if (input.type === "regular") {
    if (
      typeof input.executable !== "boolean" ||
      !Number.isSafeInteger(input.bytes) ||
      typeof input.digest !== "string" ||
      !Array.isArray(input.chunks)
    )
      throw new Error("Regular manifest is invalid");
    assertHash(input.digest, "Regular digest");
    for (const chunk of input.chunks) {
      if (typeof chunk !== "object" || chunk === null)
        throw new Error("Regular chunk is invalid");
      const item = chunk as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        !Number.isSafeInteger(item.bytes) ||
        Number(item.bytes) < 0
      )
        throw new Error("Regular chunk is invalid");
      assertHash(item.id, "Chunk ID");
    }
    return value as RegularManifest;
  }
  if (input.type === "symlink") {
    if (typeof input.target !== "string" || typeof input.digest !== "string")
      throw new Error("Symlink manifest is invalid");
    assertHash(input.digest, "Symlink digest");
    return value as SymlinkManifest;
  }
  if (input.type === "tree") {
    if (!Array.isArray(input.entries) || typeof input.digest !== "string")
      throw new Error("Tree manifest is invalid");
    assertHash(input.digest, "Tree digest");
    for (const entry of input.entries) {
      if (typeof entry !== "object" || entry === null)
        throw new Error("Tree entry is invalid");
      const item = entry as Record<string, unknown>;
      if (
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        item.name === "." ||
        item.name === ".." ||
        item.name.includes("/") ||
        item.name.includes("\\") ||
        item.name.includes("\0") ||
        !["directory", "regular", "symlink"].includes(String(item.kind)) ||
        typeof item.manifestId !== "string"
      )
        throw new Error("Tree entry is invalid");
      assertHash(item.manifestId, "Tree child manifest ID");
    }
    if (hashJson(input.entries) !== input.digest)
      throw new Error("Tree manifest digest mismatch");
    return value as TreeManifest;
  }
  throw new Error("Unknown V3 manifest type");
}

export function referencedObjects(
  manifestId: string,
  store: ObjectStore,
): readonly string[] {
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id)) return;
    result.add(id);
    const manifest = parseManifest(store.get(id));
    if (manifest.type === "regular")
      for (const chunk of manifest.chunks) result.add(chunk.id);
    if (manifest.type === "tree")
      for (const entry of manifest.entries)
        if (entry.manifestId !== null) visit(entry.manifestId);
  };
  visit(manifestId);
  return [...result];
}

export function materializeManifest(
  manifestId: string,
  destination: string,
  store: ObjectStore,
): void {
  const manifest = parseManifest(store.get(manifestId));
  if (manifest.type === "tree") {
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    for (const entry of manifest.entries) {
      const child = join(destination, entry.name);
      if (entry.manifestId === null)
        throw new Error(`Tree child has no manifest: ${entry.name}`);
      materializeManifest(entry.manifestId, child, store);
    }
    fsyncDirectory(destination);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (manifest.type === "symlink") {
    if (hashBytes(Buffer.from(manifest.target, "utf8")) !== manifest.digest)
      throw new Error(`Symlink manifest digest mismatch: ${manifestId}`);
    symlinkSync(manifest.target, destination);
    return;
  }
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    "wx",
    manifest.executable ? 0o755 : 0o644,
  );
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for (const chunk of manifest.chunks) {
      const value = store.get(chunk.id);
      if (value.length !== chunk.bytes)
        throw new Error(`Chunk length mismatch: ${chunk.id}`);
      writeSync(descriptor, value);
      digest.update(value);
      bytes += value.length;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (bytes !== manifest.bytes || digest.digest("hex") !== manifest.digest) {
    unlinkSync(temporary);
    throw new Error(`Regular manifest digest mismatch: ${manifestId}`);
  }
  renameSync(temporary, destination);
  chmodSync(destination, manifest.executable ? 0o755 : 0o644);
}

export function copyObjects(
  ids: readonly string[],
  source: ObjectStore,
  destination: ObjectStore,
): number {
  let copied = 0;
  destination.batch(() => {
    for (const id of ids) {
      if (destination.has(id)) continue;
      destination.put(source.get(id), id);
      copied += 1;
    }
  });
  return copied;
}

export function replaceWithManifest(
  root: string,
  relativePath: string,
  manifestId: string,
  store: ObjectStore,
): void {
  const destination = join(root, ...relativePath.split("/"));
  assertRealAncestors(root, destination);
  const temporary = `${destination}.codefoldersync-${randomUUID()}`;
  materializeManifest(manifestId, temporary, store);
  renameSync(temporary, destination);
}

function assertStable(before: Stats, after: Stats, path: string): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.mode !== after.mode
  )
    throw new Error(`Path changed during capture: ${path}`);
}

function fsyncDirectory(path: string): void {
  if (!existsSync(path)) return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function forEachChunk(path: string, consume: (bytes: Buffer) => void): void {
  const descriptor = openSync(path, "r");
  const input = Buffer.allocUnsafe(readBufferBytes);
  const chunk = Buffer.allocUnsafe(maximumChunk);
  let chunkBytes = 0;
  let rolling = 0;
  const flush = () => {
    if (chunkBytes === 0) return;
    consume(Buffer.from(chunk.subarray(0, chunkBytes)));
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
        )
          flush();
      }
    }
    flush();
  } finally {
    closeSync(descriptor);
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
