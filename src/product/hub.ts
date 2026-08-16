import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFolderRecord, parseSnapshot } from "./codec.js";
import { fsyncDirectory, readJson, writeJsonAtomic } from "./io.js";
import {
  productSchemaVersion,
  type FolderRecord,
  type HubCommitResponse,
  type HubRequest,
  type Snapshot,
  type UnitHead,
} from "./types.js";
import {
  assertAbsolutePath,
  assertId,
  assertSnapshotId,
  assertUnit,
} from "./validation.js";

const staleLockMs = 60 * 60 * 1000;

export function handleHubRequest(
  hubBase: string,
  request: HubRequest,
): unknown {
  assertAbsolutePath(hubBase, "Hub path");
  switch (request.type) {
    case "create-folder":
      return createFolder(hubBase, request.folder);
    case "get-folder":
      return getFolder(hubBase, request.folderId);
    case "get-folder-state":
      return getFolderState(hubBase, request.folderId);
    case "get-unit":
      return getUnit(hubBase, request.folderId, request.unit);
    case "get-snapshot":
      return getSnapshot(hubBase, request.folderId, request.snapshotId);
    case "commit":
      return commitSnapshot(
        hubBase,
        request.folderId,
        request.expectedHead,
        request.snapshot,
      );
    case "preserve-conflict":
      return preserveConflict(
        hubBase,
        request.folderId,
        request.remoteHead,
        request.snapshot,
      );
    case "history":
      return listHistory(hubBase, request.folderId, request.unit);
  }
}

function getFolderState(
  hubBase: string,
  folderId: string,
): {
  readonly folder: FolderRecord;
  readonly units: Readonly<
    Record<
      string,
      { readonly head: string | null; readonly snapshot: Snapshot | null }
    >
  >;
} {
  const folder = getFolder(hubBase, folderId);
  return {
    folder,
    units: Object.fromEntries(
      folder.units.map((unit) => [unit, getUnit(hubBase, folderId, unit)]),
    ),
  };
}

function createFolder(hubBase: string, folder: FolderRecord): FolderRecord {
  validateFolder(folder);
  const root = folderRoot(hubBase, folder.folderId);
  const recordPath = join(root, "folder.json");
  if (existsSync(recordPath)) {
    const existing = parseFolderRecord(readJson(recordPath));
    if (JSON.stringify(existing) !== JSON.stringify(folder)) {
      throw new Error(`Folder ID already exists: ${folder.folderId}`);
    }
    return existing;
  }
  mkdirSync(join(root, "units"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "snapshots"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "conflicts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "locks"), { recursive: true, mode: 0o700 });
  writeJsonAtomic(recordPath, folder);
  return folder;
}

function getFolder(hubBase: string, folderId: string): FolderRecord {
  return parseFolderRecord(
    readJson(join(folderRoot(hubBase, folderId), "folder.json")),
  );
}

function getUnit(
  hubBase: string,
  folderId: string,
  unit: string,
): { readonly head: string | null; readonly snapshot: Snapshot | null } {
  assertUnit(unit);
  const head = readHead(hubBase, folderId, unit);
  return {
    head,
    snapshot: head === null ? null : getSnapshot(hubBase, folderId, head),
  };
}

function getSnapshot(
  hubBase: string,
  folderId: string,
  snapshotId: string,
): Snapshot {
  assertSnapshotId(snapshotId);
  const snapshot = parseSnapshot(
    readJson(
      join(folderRoot(hubBase, folderId), "snapshots", `${snapshotId}.json`),
    ),
  );
  if (snapshot.folderId !== folderId)
    throw new Error("Snapshot folder mismatch");
  return snapshot;
}

function commitSnapshot(
  hubBase: string,
  folderId: string,
  expectedHead: string | null,
  snapshot: Snapshot,
): HubCommitResponse {
  validateSnapshotForFolder(hubBase, folderId, snapshot);
  if (expectedHead !== null) assertSnapshotId(expectedHead, "Expected head");
  return withUnitLock(hubBase, folderId, snapshot.unit, () => {
    writeImmutableSnapshot(hubBase, folderId, snapshot);
    const currentHead = readHead(hubBase, folderId, snapshot.unit);
    if (currentHead !== expectedHead || snapshot.parentId !== expectedHead) {
      writeConflictReference(hubBase, folderId, snapshot, currentHead);
      return { committed: false, currentHead, snapshotId: snapshot.snapshotId };
    }
    const head: UnitHead = {
      schemaVersion: productSchemaVersion,
      unit: snapshot.unit,
      snapshotId: snapshot.snapshotId,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(headPath(hubBase, folderId, snapshot.unit), head);
    return {
      committed: true,
      currentHead: snapshot.snapshotId,
      snapshotId: snapshot.snapshotId,
    };
  });
}

function preserveConflict(
  hubBase: string,
  folderId: string,
  remoteHead: string,
  snapshot: Snapshot,
): { readonly snapshotId: string; readonly remoteHead: string } {
  validateSnapshotForFolder(hubBase, folderId, snapshot);
  assertSnapshotId(remoteHead, "Remote head");
  return withUnitLock(hubBase, folderId, snapshot.unit, () => {
    const current = readHead(hubBase, folderId, snapshot.unit);
    if (current !== remoteHead)
      throw new Error("Remote head changed while preserving conflict");
    writeImmutableSnapshot(hubBase, folderId, snapshot);
    writeConflictReference(hubBase, folderId, snapshot, remoteHead);
    return { snapshotId: snapshot.snapshotId, remoteHead };
  });
}

function listHistory(
  hubBase: string,
  folderId: string,
  unit: string,
): readonly Snapshot[] {
  assertUnit(unit);
  const directory = join(folderRoot(hubBase, folderId), "snapshots");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => parseSnapshot(readJson(join(directory, name))))
    .filter((snapshot) => snapshot.unit === unit)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function writeImmutableSnapshot(
  hubBase: string,
  folderId: string,
  snapshot: Snapshot,
): void {
  const path = join(
    folderRoot(hubBase, folderId),
    "snapshots",
    `${snapshot.snapshotId}.json`,
  );
  if (existsSync(path)) {
    const existing = parseSnapshot(readJson(path));
    if (!sameImmutableSnapshot(existing, snapshot)) {
      throw new Error(`Immutable snapshot collision: ${snapshot.snapshotId}`);
    }
    return;
  }
  writeJsonAtomic(path, snapshot);
}

function sameImmutableSnapshot(left: Snapshot, right: Snapshot): boolean {
  const withoutTime = ({ createdAt: _createdAt, ...snapshot }: Snapshot) =>
    snapshot;
  return (
    JSON.stringify(withoutTime(left)) === JSON.stringify(withoutTime(right))
  );
}

function writeConflictReference(
  hubBase: string,
  folderId: string,
  snapshot: Snapshot,
  remoteHead: string | null,
): void {
  const directory = join(
    folderRoot(hubBase, folderId),
    "conflicts",
    encodeUnit(snapshot.unit),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(directory, `${snapshot.snapshotId}.json`), {
    schemaVersion: productSchemaVersion,
    unit: snapshot.unit,
    snapshotId: snapshot.snapshotId,
    remoteHead,
    preservedAt: new Date().toISOString(),
  });
}

function readHead(
  hubBase: string,
  folderId: string,
  unit: string,
): string | null {
  const path = headPath(hubBase, folderId, unit);
  if (!existsSync(path)) return null;
  const value = readJson(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unit head is invalid");
  }
  const head = value as Record<string, unknown>;
  if (
    head.schemaVersion !== productSchemaVersion ||
    head.unit !== unit ||
    typeof head.snapshotId !== "string"
  ) {
    throw new Error("Unit head is invalid");
  }
  assertSnapshotId(head.snapshotId);
  return head.snapshotId;
}

function headPath(hubBase: string, folderId: string, unit: string): string {
  assertUnit(unit);
  const directory = join(
    folderRoot(hubBase, folderId),
    "units",
    encodeUnit(unit),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, "head.json");
}

function folderRoot(hubBase: string, folderId: string): string {
  assertAbsolutePath(hubBase, "Hub path");
  assertId(folderId, "Folder ID");
  return resolve(hubBase, folderId);
}

function validateFolder(folder: FolderRecord): void {
  if (
    folder.schemaVersion !== productSchemaVersion ||
    folder.protocolVersion !== productSchemaVersion
  ) {
    throw new Error("Unsupported folder record version");
  }
  assertId(folder.folderId, "Folder ID");
  if (folder.folderName.length === 0) throw new Error("Folder name is empty");
  if (folder.units.length === 0) throw new Error("Folder has no repositories");
  for (const unit of folder.units) assertUnit(unit);
}

function validateSnapshotForFolder(
  hubBase: string,
  folderId: string,
  snapshot: Snapshot,
): void {
  if (snapshot.folderId !== folderId)
    throw new Error("Snapshot folder mismatch");
  const folder = getFolder(hubBase, folderId);
  if (!folder.units.includes(snapshot.unit))
    throw new Error("Snapshot unit is not registered");
}

function withUnitLock<T>(
  hubBase: string,
  folderId: string,
  unit: string,
  action: () => T,
): T {
  const locks = join(folderRoot(hubBase, folderId), "locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = join(locks, `${encodeUnit(unit)}.lock`);
  acquireLock(lock, locks);
  try {
    writeJsonAtomic(join(lock, "owner.json"), {
      schemaVersion: productSchemaVersion,
      owner: randomUUID(),
      acquiredAt: new Date().toISOString(),
    });
    return action();
  } finally {
    const owner = join(lock, "owner.json");
    if (existsSync(owner)) unlinkSync(owner);
    rmdirSync(lock);
    fsyncDirectory(locks);
  }
}

function acquireLock(lock: string, locks: string): void {
  try {
    mkdirSync(lock, { mode: 0o700 });
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const age = Date.now() - statSync(lock).mtimeMs;
  if (age <= staleLockMs) throw new Error("Repository hub lock is busy");
  const stale = join(
    locks,
    `${lock.split("/").at(-1) ?? "lock"}.stale-${randomUUID()}`,
  );
  renameSync(lock, stale);
  fsyncDirectory(locks);
  mkdirSync(lock, { mode: 0o700 });
}

function encodeUnit(unit: string): string {
  assertUnit(unit);
  return Buffer.from(unit, "utf8").toString("base64url");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}
