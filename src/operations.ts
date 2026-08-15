import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.js";
import { DurableJournal } from "./journal.js";
import { sha256 } from "./manifest.js";
import { assertSafeRelativePath, type RunPaths } from "./paths.js";
import type { JournalEntry, PeerName, RepositoryName } from "./types.js";

interface OperationContext {
  readonly runId: string;
  readonly peer: PeerName;
  readonly repository: RepositoryName;
  readonly controllerJournal?: DurableJournal;
  readonly peerJournal: DurableJournal;
  readonly peerPaths: RunPaths;
}

function entry(
  context: OperationContext,
  operationId: string,
  action: string,
  phase: JournalEntry["phase"],
  source: JournalEntry["source"],
  evidence: Partial<
    Pick<
      JournalEntry,
      | "relativePath"
      | "token"
      | "digest"
      | "commitOid"
      | "refName"
      | "backupRef"
      | "detail"
    >
  > = {},
): JournalEntry {
  return {
    schemaVersion: 1,
    runId: context.runId,
    operationId,
    timestamp: new Date().toISOString(),
    peer: context.peer,
    repository: context.repository,
    action,
    phase,
    source,
    ...evidence,
  };
}

export function writeCanary(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly relativePath: string;
    readonly contentPrefix?: string;
  },
): { readonly token: string; readonly digest: string } {
  assertSafeRelativePath(input.relativePath);
  const token = `TSH:${context.runId}:${input.operationId}:${context.peer}`;
  const content = `${input.contentPrefix ?? "generated"}\n${token}\n`;
  const evidence = { relativePath: input.relativePath, token };
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "write",
      "planned",
      "controller",
      evidence,
    ),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "write", "started", "peer", evidence),
  );
  const destination = join(
    context.peerPaths.workspace,
    context.repository,
    input.relativePath,
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  const digest = sha256(content);
  const observed = { ...evidence, digest };
  context.peerJournal.append(
    entry(context, input.operationId, "write", "observed", "peer", observed),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "write", "completed", "peer", observed),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "write",
      "completed",
      "controller",
      observed,
    ),
  );
  return { token, digest };
}

export function createCommit(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly branch: string;
    readonly relativePath: string;
    readonly backupRef?: string;
  },
): {
  readonly commitOid: string;
  readonly refName: string;
  readonly backupRef?: string;
} {
  assertSafeRelativePath(input.relativePath);
  const repositoryPath = join(context.peerPaths.workspace, context.repository);
  const refName = `refs/heads/${input.branch}`;
  const basic = { relativePath: input.relativePath, refName };
  context.controllerJournal?.append(
    entry(context, input.operationId, "commit", "planned", "controller", basic),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "commit", "started", "peer", basic),
  );
  git(repositoryPath, ["switch", "-c", input.branch]);
  const token = `TSH:${context.runId}:${input.operationId}:${context.peer}`;
  const destination = join(repositoryPath, input.relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${token}\n`);
  git(repositoryPath, ["add", input.relativePath]);
  git(repositoryPath, ["commit", "-m", `harness: ${input.operationId}`]);
  const commitOid = git(repositoryPath, ["rev-parse", "HEAD"]).stdout.trim();
  if (input.backupRef !== undefined)
    git(repositoryPath, ["update-ref", input.backupRef, commitOid]);
  const observed = {
    ...basic,
    commitOid,
    ...(input.backupRef === undefined ? {} : { backupRef: input.backupRef }),
  };
  context.peerJournal.append(
    entry(context, input.operationId, "commit", "observed", "peer", observed),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "commit", "completed", "peer", observed),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "commit",
      "completed",
      "controller",
      observed,
    ),
  );
  return {
    commitOid,
    refName,
    ...(input.backupRef === undefined ? {} : { backupRef: input.backupRef }),
  };
}

export type { OperationContext };
