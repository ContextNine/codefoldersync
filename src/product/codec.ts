import {
  productSchemaVersion,
  type FolderRecord,
  type HubRequest,
  type HubResponse,
  type Snapshot,
  type SnapshotFile,
} from "./types.js";
import { validateSnapshot } from "./snapshot.js";

export function parseSnapshot(value: unknown): Snapshot {
  const input = record(value, "Snapshot");
  const filesRaw = input.files;
  if (!Array.isArray(filesRaw))
    throw new Error("Snapshot files must be an array");
  const snapshot: Snapshot = {
    schemaVersion: literalOne(input.schemaVersion, "Snapshot schema version"),
    snapshotId: string(input.snapshotId, "Snapshot ID"),
    folderId: string(input.folderId, "Folder ID"),
    unit: string(input.unit, "Unit"),
    parentId: nullableString(input.parentId, "Parent ID"),
    peerId: string(input.peerId, "Peer ID"),
    createdAt: string(input.createdAt, "Created at"),
    treeDigest: string(input.treeDigest, "Tree digest"),
    files: filesRaw.map(parseSnapshotFile),
  };
  validateSnapshot(snapshot);
  return snapshot;
}

export function parseFolderRecord(value: unknown): FolderRecord {
  const input = record(value, "Folder record");
  if (!Array.isArray(input.units))
    throw new Error("Folder units must be an array");
  return {
    schemaVersion: literalOne(input.schemaVersion, "Folder schema version"),
    protocolVersion: literalOne(input.protocolVersion, "Protocol version"),
    folderId: string(input.folderId, "Folder ID"),
    folderName: string(input.folderName, "Folder name"),
    units: input.units.map((unit, index) => string(unit, `Unit ${index}`)),
    createdAt: string(input.createdAt, "Created at"),
  };
}

export function parseHubRequest(value: unknown): HubRequest {
  const input = record(value, "Hub request");
  const type = string(input.type, "Request type");
  switch (type) {
    case "create-folder":
      return { type, folder: parseFolderRecord(input.folder) };
    case "get-folder":
      return { type, folderId: string(input.folderId, "Folder ID") };
    case "get-folder-state":
      return { type, folderId: string(input.folderId, "Folder ID") };
    case "get-unit":
      return {
        type,
        folderId: string(input.folderId, "Folder ID"),
        unit: string(input.unit, "Unit"),
      };
    case "get-snapshot":
      return {
        type,
        folderId: string(input.folderId, "Folder ID"),
        snapshotId: string(input.snapshotId, "Snapshot ID"),
      };
    case "commit":
      return {
        type,
        folderId: string(input.folderId, "Folder ID"),
        expectedHead: nullableString(input.expectedHead, "Expected head"),
        snapshot: parseSnapshot(input.snapshot),
      };
    case "preserve-conflict":
      return {
        type,
        folderId: string(input.folderId, "Folder ID"),
        remoteHead: string(input.remoteHead, "Remote head"),
        snapshot: parseSnapshot(input.snapshot),
      };
    case "history":
      return {
        type,
        folderId: string(input.folderId, "Folder ID"),
        unit: string(input.unit, "Unit"),
      };
    default:
      throw new Error(`Unknown hub request: ${type}`);
  }
}

export function parseHubResponse(value: unknown): HubResponse {
  const input = record(value, "Hub response");
  if (input.ok === true) return { ok: true, value: input.value };
  if (input.ok === false)
    return { ok: false, error: string(input.error, "Hub error") };
  throw new Error("Hub response has invalid status");
}

function parseSnapshotFile(value: unknown, index: number): SnapshotFile {
  const input = record(value, `Snapshot file ${index}`);
  return {
    path: string(input.path, "File path"),
    digest: string(input.digest, "File digest"),
    bytes: nonNegativeInteger(input.bytes, "File bytes"),
    executable: boolean(input.executable, "Executable"),
    content: stringAllowEmpty(input.content, "File content"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function literalOne(
  value: unknown,
  label: string,
): typeof productSchemaVersion {
  if (value !== productSchemaVersion)
    throw new Error(`${label} is unsupported`);
  return productSchemaVersion;
}
