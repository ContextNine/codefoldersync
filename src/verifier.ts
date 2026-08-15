import { existsSync } from "node:fs";
import { join } from "node:path";
import { requiredCommitExists, refEquals, snapshotGit } from "./git.js";
import { reconcileJournals } from "./journal.js";
import { buildManifest, digestManifest, findToken } from "./manifest.js";
import type { RunPaths } from "./paths.js";
import {
  repositoryNames,
  type JournalEntry,
  type VerificationIssue,
  type VerificationResult,
} from "./types.js";

export function verifyPeer(input: {
  readonly paths: RunPaths;
  readonly controllerEntries: readonly JournalEntry[];
  readonly peerEntries: readonly JournalEntry[];
}): VerificationResult {
  const manifest = buildManifest(input.paths.workspace);
  const issues: VerificationIssue[] = [];
  const reconciliation = reconcileJournals(
    input.controllerEntries,
    input.peerEntries,
  );
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
      }
    }
    if (operation.commitOid !== undefined) {
      const repositoryPath = join(input.paths.workspace, operation.repository);
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
    issues,
    requiredOperations: reconciliation.required.length,
    recoveredOperations,
  };
}
