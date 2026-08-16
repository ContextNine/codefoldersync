export const peerNames = ["alpha", "beta", "gamma"] as const;
export const repositoryNames = ["atlas", "birch", "coral"] as const;

export type PeerName = (typeof peerNames)[number];
export type RepositoryName = (typeof repositoryNames)[number];
export type ScenarioName = "serial" | "conflict" | "churn";
export type ScenarioMode = "raw" | "guarded";
export type AdapterName = "fake" | "codefoldersync";
export type OperationPhase =
  "planned" | "started" | "observed" | "completed" | "interrupted";

export interface JournalEntry {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly operationId: string;
  readonly timestamp: string;
  readonly peer: PeerName;
  readonly repository: RepositoryName;
  readonly action: string;
  readonly phase: OperationPhase;
  readonly relativePath?: string;
  readonly token?: string;
  readonly digest?: string;
  readonly commitOid?: string;
  readonly refName?: string;
  readonly backupRef?: string;
  readonly indexTree?: string;
  readonly indexBackupRef?: string;
  readonly source: "controller" | "peer";
  readonly detail?: string;
}

export interface ManifestEntry {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly executable: boolean;
}

export interface GitSnapshot {
  readonly repository: RepositoryName;
  readonly valid: boolean;
  readonly fsckOutput: string;
  readonly head: string;
  readonly headOid: string;
  readonly indexTree: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly statusDigest: string;
}

export interface RequiredOperation {
  readonly operationId: string;
  readonly peer: PeerName;
  readonly repository: RepositoryName;
  readonly action: string;
  readonly relativePath?: string;
  readonly token?: string;
  readonly digest?: string;
  readonly commitOid?: string;
  readonly refName?: string;
  readonly backupRef?: string;
  readonly indexTree?: string;
  readonly indexBackupRef?: string;
}

export interface VerificationIssue {
  readonly code: string;
  readonly message: string;
  readonly operationId?: string;
  readonly peer?: PeerName;
  readonly repository?: RepositoryName;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly manifestDigest: string;
  readonly gitSemanticDigest: string;
  readonly classifications: readonly string[];
  readonly issues: readonly VerificationIssue[];
  readonly requiredOperations: number;
  readonly recoveredOperations: number;
}

export interface PeerConfig {
  readonly name: PeerName;
  readonly host: "local" | string;
  readonly runBase: string;
  readonly nodeBinary: string;
}

export interface HarnessConfig {
  readonly quietSamples: number;
  readonly quietIntervalMs: number;
  readonly convergenceTimeoutMs: number;
  readonly peers: readonly PeerConfig[];
}

export interface ScenarioResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scenario: ScenarioName;
  readonly mode: ScenarioMode;
  readonly adapter: AdapterName;
  readonly seed: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly verdict:
    | "pass"
    | "product-failure"
    | "guarded-denial"
    | "harness-failure"
    | "inconclusive-readiness"
    | "inconclusive-timeout";
  readonly verification: Readonly<Record<PeerName, VerificationResult>>;
  readonly notes: readonly string[];
}
