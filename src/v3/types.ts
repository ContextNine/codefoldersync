export const schemaVersion = 3 as const;
export const protocolVersion = 3 as const;

export type NodeKind = "directory" | "regular" | "symlink";
export type LifecycleMode = "adoption" | "normal";
export type PeerRole = "authority" | "peer" | "hub";

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

export interface PeerRecord {
  readonly peerId: string;
  readonly peerName: string;
  readonly role: PeerRole;
  readonly root: string;
  readonly publicKey: string;
}

export interface AuthorityRecord {
  readonly peerId: string;
  readonly publicKey: string;
}

export interface UnsignedFolderConfig {
  readonly schemaVersion: typeof schemaVersion;
  readonly protocolVersion: typeof protocolVersion;
  readonly revision: number;
  readonly folderId: string;
  readonly folderName: string;
  readonly root: string;
  readonly stateDir: string;
  readonly peerId: string;
  readonly peerName: string;
  readonly hub: HubConfig;
  readonly authority: AuthorityRecord;
  readonly peers: readonly PeerRecord[];
  readonly ignoreDigest: string;
  readonly lifecycle: LifecycleMode;
  readonly backupWitness: string | null;
  readonly service?: {
    readonly intervalMs: number;
    readonly reconcileSeconds: number;
  };
}

export interface ProductConfig extends UnsignedFolderConfig {
  readonly signature: string;
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

export interface CatalogEntry {
  readonly path: string;
  readonly parentPath: string | null;
  readonly parentNodeId: string;
  readonly name: string;
  readonly portableName: string;
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly manifestId: string | null;
  readonly executable: boolean;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export type GitBoundaryKind = "physical" | "indirection" | "submodule";

export interface GitBoundary {
  readonly boundaryId: string;
  readonly worktreePath: string;
  readonly gitPath: string;
  readonly kind: GitBoundaryKind;
  readonly manifestId: string;
}

export interface NamespaceManifest {
  readonly schemaVersion: typeof schemaVersion;
  readonly folderId: string;
  readonly ignoreDigest: string;
  readonly entries: readonly CatalogEntry[];
  readonly gitBoundaries: readonly GitBoundary[];
  readonly createdAt: string;
  readonly digest: string;
}

interface MutationBase {
  readonly folderId: string;
  readonly peerId: string;
  readonly eventId: string;
  readonly peerSequence: number;
  readonly baseConfigRevision: number;
  readonly nodeId: string;
  readonly baseEntryVersion: string | null;
  readonly baseContentVersion: string | null;
  readonly objectIds: readonly string[];
}

export interface PutNodeMutation extends MutationBase {
  readonly kind: "put-node";
  readonly path: string;
  readonly entryVersion: string;
  readonly contentVersion: string;
}

export interface MoveEntryMutation extends MutationBase {
  readonly kind: "move-entry";
  readonly fromPath: string;
  readonly path: string;
  readonly entryVersion: string;
  readonly contentVersion: string;
}

export interface DeleteEntryMutation extends MutationBase {
  readonly kind: "delete-entry";
  readonly path: string;
  readonly entryVersion: null;
  readonly contentVersion: null;
}

export interface RestoreEntryMutation extends MutationBase {
  readonly kind: "restore-entry";
  readonly path: string;
  readonly entryVersion: string;
  readonly contentVersion: string;
}

export interface GitStateMutation extends MutationBase {
  readonly kind: "git-state";
  readonly path: string;
  readonly entryVersion: string | null;
  readonly contentVersion: string | null;
}

export type NamespaceMutation =
  | PutNodeMutation
  | MoveEntryMutation
  | DeleteEntryMutation
  | RestoreEntryMutation
  | GitStateMutation;

export interface SignedSnapshot {
  readonly snapshot: NamespaceManifest;
  readonly peerId: string;
  readonly baseSequence: number;
  readonly eventId: string;
  readonly peerSequence: number;
  readonly mutations: readonly NamespaceMutation[];
  readonly conflicts: readonly ConflictRecord[];
  readonly signature: string;
}

export interface HubCheckpoint {
  readonly sequence: number;
  readonly config: ProductConfig;
  readonly snapshot: NamespaceManifest | null;
}

export type AdoptionClassification =
  | "exact"
  | "source-only"
  | "target-only"
  | "divergent"
  | "moved-equivalent"
  | "type-conflicting"
  | "unrepresentable";

export interface AdoptionDifference {
  readonly path: string;
  readonly classification: AdoptionClassification;
  readonly sourcePath: string | null;
  readonly targetPath: string | null;
  readonly bytes: number;
}

export interface AdoptionPlan {
  readonly schemaVersion: typeof schemaVersion;
  readonly adoptionId: string;
  readonly folderId: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly targetPeerId: string;
  readonly targetDigest: string;
  /** Encrypted with the rest of the target-local plan for restart validation. */
  readonly targetSnapshot: NamespaceManifest;
  readonly createdAt: string;
  readonly differences: readonly AdoptionDifference[];
  readonly summary: Readonly<Record<AdoptionClassification, number>>;
}

export interface ConflictRecord {
  readonly conflictId: string;
  readonly kind: "normal" | "adoption" | "git";
  readonly peerId: string;
  readonly originalPath: string;
  readonly recoveryPath: string;
  readonly manifestId: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

export interface SignedConflict {
  readonly folderId: string;
  readonly peerId: string;
  readonly eventId: string;
  readonly conflict: ConflictRecord;
  readonly signature: string;
}

export interface SignedAdoptionVerification {
  readonly folderId: string;
  readonly peerId: string;
  readonly eventId: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly signature: string;
}

export interface SyncSummary {
  readonly folderId: string;
  readonly peerId: string;
  readonly status: "clean" | "conflict" | "offline" | "inconclusive";
  readonly scanned: number;
  readonly published: boolean;
  readonly applied: boolean;
  readonly conflicts: number;
  readonly uploadedObjects: number;
  readonly downloadedObjects: number;
  readonly hubSequence: number;
  readonly reasons: readonly string[];
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly manager: "launchd" | "systemd" | "unsupported";
  readonly label: string;
  readonly definitionPath: string;
}
