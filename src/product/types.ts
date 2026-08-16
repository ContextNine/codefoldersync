export const productSchemaVersion = 1 as const;

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

export interface ProductConfig {
  readonly schemaVersion: typeof productSchemaVersion;
  readonly folderId: string;
  readonly folderName: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly root: string;
  readonly stateDir: string;
  readonly units: readonly string[];
  readonly hub: HubConfig;
}

export interface SnapshotFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly executable: boolean;
  readonly content: string;
}

export interface Snapshot {
  readonly schemaVersion: typeof productSchemaVersion;
  readonly snapshotId: string;
  readonly folderId: string;
  readonly unit: string;
  readonly parentId: string | null;
  readonly peerId: string;
  readonly createdAt: string;
  readonly treeDigest: string;
  readonly files: readonly SnapshotFile[];
}

export interface FolderRecord {
  readonly schemaVersion: typeof productSchemaVersion;
  readonly protocolVersion: typeof productSchemaVersion;
  readonly folderId: string;
  readonly folderName: string;
  readonly units: readonly string[];
  readonly createdAt: string;
}

export interface UnitHead {
  readonly schemaVersion: typeof productSchemaVersion;
  readonly unit: string;
  readonly snapshotId: string;
  readonly updatedAt: string;
}

export interface BlockedUnit {
  readonly baselineId: string | null;
  readonly localSnapshotId: string;
  readonly remoteSnapshotId: string;
  readonly detectedAt: string;
}

export interface UnitState {
  readonly baselineId?: string;
  readonly baselineDigest?: string;
  readonly blocked?: BlockedUnit;
}

export interface ClientState {
  readonly schemaVersion: typeof productSchemaVersion;
  readonly folderId: string;
  readonly peerId: string;
  readonly units: Readonly<Record<string, UnitState>>;
}

export type UnitStatusKind =
  "clean" | "local-ahead" | "remote-ahead" | "blocked" | "inconclusive";

export interface UnitStatus {
  readonly unit: string;
  readonly status: UnitStatusKind;
  readonly baselineId: string | null;
  readonly localDigest: string | null;
  readonly remoteHeadId: string | null;
  readonly reason?: string;
}

export interface SyncUnitResult {
  readonly unit: string;
  readonly action:
    | "initialized"
    | "published"
    | "applied"
    | "coalesced"
    | "clean"
    | "blocked"
    | "inconclusive";
  readonly snapshotId?: string;
  readonly reason?: string;
}

export interface HubCommitResponse {
  readonly committed: boolean;
  readonly currentHead: string | null;
  readonly snapshotId: string;
}

export type HubRequest =
  | { readonly type: "create-folder"; readonly folder: FolderRecord }
  | { readonly type: "get-folder"; readonly folderId: string }
  | { readonly type: "get-folder-state"; readonly folderId: string }
  | {
      readonly type: "get-unit";
      readonly folderId: string;
      readonly unit: string;
    }
  | {
      readonly type: "get-snapshot";
      readonly folderId: string;
      readonly snapshotId: string;
    }
  | {
      readonly type: "commit";
      readonly folderId: string;
      readonly expectedHead: string | null;
      readonly snapshot: Snapshot;
    }
  | {
      readonly type: "preserve-conflict";
      readonly folderId: string;
      readonly remoteHead: string;
      readonly snapshot: Snapshot;
    }
  | {
      readonly type: "history";
      readonly folderId: string;
      readonly unit: string;
    };

export type HubResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
