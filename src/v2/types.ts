export const schemaVersion = 2 as const;
export const protocolVersion = 2 as const;

export type NodeKind = "directory" | "regular" | "symlink";
export type ObjectEncoding = "raw" | "brotli";

export interface LocalHubConfig {
  readonly kind: "local";
  readonly path: string;
}

export interface SshHubConfig {
  readonly kind: "ssh";
  readonly host: string;
  readonly path: string;
  readonly command: readonly string[];
}

export type HubConfig = LocalHubConfig | SshHubConfig;

export interface RepositoryConfig {
  readonly name: string;
  readonly rootNodeId: string;
}

export interface ProductConfig {
  readonly schemaVersion: typeof schemaVersion;
  readonly folderId: string;
  readonly folderName: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly root: string;
  readonly stateDir: string;
  readonly repositories: readonly RepositoryConfig[];
  readonly hub: HubConfig;
  readonly service?: {
    readonly intervalMs: number;
    readonly reconcileSeconds: number;
  };
}

export interface ChunkRef {
  readonly id: string;
  readonly bytes: number;
}

export interface RegularManifest {
  readonly schemaVersion: typeof schemaVersion;
  readonly type: "regular";
  readonly executable: boolean;
  readonly bytes: number;
  readonly digest: string;
  readonly chunks: readonly ChunkRef[];
}

export interface SymlinkManifest {
  readonly schemaVersion: typeof schemaVersion;
  readonly type: "symlink";
  readonly target: string;
  readonly digest: string;
}

export interface TreeManifestEntry {
  readonly name: string;
  readonly kind: NodeKind;
  readonly manifestId: string | null;
}

export interface TreeManifest {
  readonly schemaVersion: typeof schemaVersion;
  readonly type: "tree";
  readonly entries: readonly TreeManifestEntry[];
  readonly digest: string;
}

export type ContentManifest = RegularManifest | SymlinkManifest | TreeManifest;

export interface StoredObject {
  readonly id: string;
  readonly bytes: Buffer;
}

export interface FolderRecord {
  readonly schemaVersion: typeof schemaVersion;
  readonly protocolVersion: typeof protocolVersion;
  readonly folderId: string;
  readonly folderName: string;
  readonly repositories: readonly RepositoryConfig[];
  readonly ignorePatterns: readonly string[];
  readonly createdAt: string;
}

export interface EntryRecord {
  readonly repository: string;
  readonly parentNodeId: string;
  readonly name: string;
  readonly nodeId: string;
  readonly entryVersion: string;
}

export interface NodeRecord {
  readonly repository: string;
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly manifestId: string | null;
  readonly contentVersion: string;
}

export interface GitStateRecord {
  readonly repository: string;
  readonly manifestId: string | null;
  readonly version: string | null;
}

export interface Checkpoint {
  readonly folder: FolderRecord;
  readonly sequence: number;
  readonly entries: readonly EntryRecord[];
  readonly nodes: readonly NodeRecord[];
  readonly gitStates: readonly GitStateRecord[];
}

export interface PutMutation {
  readonly kind: "put";
  readonly repository: string;
  readonly nodeId: string;
  readonly nodeKind: NodeKind;
  readonly parentNodeId: string;
  readonly name: string;
  readonly baseEntryVersion: string | null;
  readonly baseContentVersion: string | null;
  readonly manifestId: string | null;
}

export interface DeleteMutation {
  readonly kind: "delete";
  readonly repository: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly name: string;
  readonly baseEntryVersion: string;
  readonly baseContentVersion: string;
}

export interface RenameMutation {
  readonly kind: "rename";
  readonly repository: string;
  readonly nodeId: string;
  readonly fromParentNodeId: string;
  readonly fromName: string;
  readonly toParentNodeId: string;
  readonly toName: string;
  readonly baseEntryVersion: string;
}

export interface GitMutation {
  readonly kind: "git-state";
  readonly repository: string;
  readonly baseVersion: string | null;
  readonly manifestId: string;
}

export type Mutation =
  PutMutation | DeleteMutation | RenameMutation | GitMutation;

export interface EventRequest {
  readonly schemaVersion: typeof schemaVersion;
  readonly eventId: string;
  readonly folderId: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly peerSequence: number;
  readonly createdAt: string;
  readonly mutation: Mutation;
}

export type EventDisposition =
  "canonical" | "conflict" | "coalesced" | "tombstone-conflict";

export interface EventResult {
  readonly eventId: string;
  readonly hubSequence: number;
  readonly disposition: EventDisposition;
  readonly repository: string;
  readonly nodeId: string | null;
  readonly path: string | null;
  readonly entryVersion: string | null;
  readonly contentVersion: string | null;
  readonly conflictId?: string;
}

export interface ChangeBatch {
  readonly after: number;
  readonly sequence: number;
  readonly hasMore: boolean;
  readonly changes: readonly {
    readonly event: EventRequest;
    readonly result: EventResult;
  }[];
}

export interface ConflictRecord {
  readonly conflictId: string;
  readonly folderId: string;
  readonly repository: string;
  readonly originalPath: string;
  readonly conflictPath: string | null;
  readonly canonicalEventId: string | null;
  readonly conflictEventId: string;
  readonly peerName: string;
  readonly kind: "content" | "entry" | "delete" | "git";
  readonly manifestId: string | null;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolution?: "canonical" | "conflict" | "filesystem";
}

export interface LocalEntry extends EntryRecord, NodeRecord {
  readonly path: string;
  readonly device: number | null;
  readonly inode: number | null;
  readonly observedSize: number | null;
  readonly observedMtimeMs: number | null;
  readonly observedCtimeMs: number | null;
  readonly observedMode: number | null;
}

export interface SyncSummary {
  readonly folderId: string;
  readonly peerId: string;
  readonly scanned: number;
  readonly published: number;
  readonly applied: number;
  readonly conflicts: number;
  readonly uploadedObjects: number;
  readonly uploadedBytes: number;
  readonly downloadedObjects: number;
  readonly downloadedBytes: number;
  readonly hubSequence: number;
  readonly status: "clean" | "conflict" | "offline" | "inconclusive";
  readonly reasons: readonly string[];
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly manager: "launchd" | "systemd" | "unsupported";
  readonly label: string;
  readonly definitionPath: string;
}
