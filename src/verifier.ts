import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  digestGitSnapshots,
  git,
  requiredCommitExists,
  refEquals,
  snapshotGit,
} from "./git.js";
import { reconcileJournals } from "./journal.js";
import { buildManifest, digestManifest, findToken } from "./manifest.js";
import type { RunPaths } from "./paths.js";
import {
  peerNames,
  repositoryNames,
  type JournalEntry,
  type PeerName,
  type VerificationIssue,
  type VerificationResult,
} from "./types.js";

export function verifyPeer(input: {
  readonly paths: RunPaths;
  readonly controllerEntries: readonly JournalEntry[];
  readonly peerEntries: readonly JournalEntry[];
}): VerificationResult {
  const manifest = buildManifest(input.paths.workspace);
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
  const issues: VerificationIssue[] = [];
  const classifications = new Set<string>();
  const reconciliation = reconcileJournals(
    input.controllerEntries,
    input.peerEntries,
  );
  const gitSnapshots = [];
  for (const operationId of reconciliation.ambiguousOperationIds) {
    issues.push({
      code: "ambiguous-operation",
      message: `Operation ${operationId} started without a durable observed state`,
      operationId,
    });
  }
  for (const operationId of reconciliation.disagreements) {
    issues.push({
      code: "journal-disagreement",
      message: `Controller and peer evidence disagree for ${operationId}`,
      operationId,
    });
  }

  let recoveredOperations = 0;
  for (const operation of reconciliation.required) {
    let recovered = true;
    const repositoryPath = join(input.paths.workspace, operation.repository);
    if (operation.token !== undefined) {
      const locations = findToken(input.paths.workspace, operation.token);
      if (locations.length === 0) {
        recovered = false;
        issues.push({
          code: "missing-token",
          message: `No file contains the completed operation token`,
          operationId: operation.operationId,
          peer: operation.peer,
          repository: operation.repository,
        });
      } else if (operation.digest !== undefined) {
        const exactLocations = locations.filter(
          (location) =>
            manifestByPath.get(location)?.digest === operation.digest,
        );
        if (exactLocations.length === 0) {
          recovered = false;
          issues.push({
            code: "altered-canary",
            message: `The operation token survives, but no copy has the observed digest`,
            operationId: operation.operationId,
            peer: operation.peer,
            repository: operation.repository,
          });
        } else if (operation.relativePath !== undefined) {
          const expectedPath = `${operation.repository}/${operation.relativePath}`;
          if (!exactLocations.includes(expectedPath)) {
            const sidecarLocations = exactLocations.filter((location) =>
              isRecognizedConflictSidecar(location, operation.repository),
            );
            if (sidecarLocations.length === 0) {
              recovered = false;
              issues.push({
                code: "unexpected-canary-path",
                message: `Exact operation bytes survive only at an unrecognized path`,
                operationId: operation.operationId,
                peer: operation.peer,
                repository: operation.repository,
              });
            } else {
              classifications.add(
                `conflict-sidecar:${operation.operationId}:${sidecarLocations.join(",")}`,
              );
            }
          }
        }
      }
    }
    if (operation.commitOid !== undefined) {
      if (!requiredCommitExists(repositoryPath, operation.commitOid)) {
        recovered = false;
        issues.push({
          code: "missing-commit",
          message: `Commit ${operation.commitOid} is not present`,
          operationId: operation.operationId,
          repository: operation.repository,
        });
      }
      if (
        operation.refName !== undefined &&
        !refEquals(repositoryPath, operation.refName, operation.commitOid)
      ) {
        recovered = false;
        issues.push({
          code: "lost-ref-meaning",
          message: `${operation.refName} does not resolve to ${operation.commitOid}`,
          operationId: operation.operationId,
          repository: operation.repository,
        });
      }
      if (
        operation.backupRef !== undefined &&
        !refEquals(repositoryPath, operation.backupRef, operation.commitOid)
      ) {
        recovered = false;
        issues.push({
          code: "missing-backup-ref",
          message: `${operation.backupRef} does not preserve ${operation.commitOid}`,
          operationId: operation.operationId,
          repository: operation.repository,
        });
      }
    }
    if (
      operation.action === "delete" &&
      operation.relativePath !== undefined &&
      existsSync(join(repositoryPath, operation.relativePath))
    ) {
      const conflictingWrite = reconciliation.required.some(
        (candidate) =>
          candidate.operationId !== operation.operationId &&
          candidate.repository === operation.repository &&
          candidate.action !== "delete" &&
          candidate.relativePath !== undefined &&
          (candidate.relativePath === operation.relativePath ||
            candidate.relativePath.startsWith(`${operation.relativePath}/`)),
      );
      if (conflictingWrite) {
        classifications.add(
          `delete-conflict-retained-data:${operation.operationId}`,
        );
      } else {
        recovered = false;
        issues.push({
          code: "delete-intent-not-applied",
          message: `Deleted path ${operation.relativePath} still exists without a concurrent write`,
          operationId: operation.operationId,
          peer: operation.peer,
          repository: operation.repository,
        });
      }
    }
    if (operation.indexTree !== undefined) {
      const currentIndex = git(repositoryPath, ["write-tree"], true);
      const currentMatches =
        currentIndex.status === 0 &&
        currentIndex.stdout.trim() === operation.indexTree;
      const backupMatches =
        operation.indexBackupRef !== undefined &&
        refEquals(
          repositoryPath,
          operation.indexBackupRef,
          operation.indexTree,
        );
      if (backupMatches && !currentMatches)
        classifications.add(
          `index-tree-preserved-by-backup:${operation.operationId}`,
        );
      if (!currentMatches && !backupMatches) {
        recovered = false;
        issues.push({
          code: "lost-index-meaning",
          message: `Neither the current index nor a backup ref preserves tree ${operation.indexTree}`,
          operationId: operation.operationId,
          peer: operation.peer,
          repository: operation.repository,
        });
      }
    }
    if (recovered) recoveredOperations += 1;
  }

  for (const repository of repositoryNames) {
    const repositoryPath = join(input.paths.workspace, repository);
    if (!existsSync(repositoryPath)) {
      issues.push({
        code: "missing-repository",
        message: `Repository ${repository} is missing`,
        repository,
      });
      continue;
    }
    const snapshot = snapshotGit(repository, repositoryPath);
    gitSnapshots.push(snapshot);
    if (!snapshot.valid) {
      issues.push({
        code: "invalid-git-repository",
        message: `Git validation failed for ${repository}: ${snapshot.fsckOutput}`,
        repository,
      });
    }
  }

  return {
    passed: issues.length === 0,
    manifestDigest: digestManifest(manifest),
    gitSemanticDigest: digestGitSnapshots(gitSnapshots),
    classifications: [...classifications].sort(),
    issues,
    requiredOperations: reconciliation.required.length,
    recoveredOperations,
  };
}

function isRecognizedConflictSidecar(
  location: string,
  repository: string,
): boolean {
  if (!location.startsWith(`${repository}/`)) return false;
  return location
    .split("/")
    .some((part) => /\(conflict(?: directory)? from [^)]+\)/i.test(part));
}

export function enforcePeerAgreement(
  verification: Readonly<Record<PeerName, VerificationResult>>,
): Readonly<Record<PeerName, VerificationResult>> {
  const manifestDigests = new Set(
    peerNames.map((peer) => verification[peer].manifestDigest),
  );
  const semanticDigests = new Set(
    peerNames.map((peer) => verification[peer].gitSemanticDigest),
  );
  if (manifestDigests.size === 1 && semanticDigests.size === 1)
    return verification;

  const addIssues = (peer: PeerName): VerificationResult => {
    const current = verification[peer];
    const agreementIssues: VerificationIssue[] = [];
    if (manifestDigests.size !== 1)
      agreementIssues.push({
        code: "peer-filesystem-divergence",
        message: "Normalized filesystem manifests differ across peers",
        peer,
      });
    if (semanticDigests.size !== 1)
      agreementIssues.push({
        code: "peer-git-divergence",
        message: "Git semantic snapshots differ across peers",
        peer,
      });
    return {
      ...current,
      passed: false,
      issues: [...current.issues, ...agreementIssues],
    };
  };
  return {
    alpha: addIssues("alpha"),
    beta: addIssues("beta"),
    gamma: addIssues("gamma"),
  };
}
