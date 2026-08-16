import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      | "indexTree"
      | "indexBackupRef"
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
  const token = `CFS:${context.runId}:${input.operationId}:${context.peer}`;
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

/** Exercises an actual append or replacement while journaling the final bytes. */
export function mutateCanary(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly relativePath: string;
    readonly mutation: "append" | "replace";
  },
): { readonly token: string; readonly digest: string } {
  assertSafeRelativePath(input.relativePath);
  const token = `CFS:${context.runId}:${input.operationId}:${context.peer}`;
  const destination = join(
    context.peerPaths.workspace,
    context.repository,
    input.relativePath,
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${input.mutation} baseline\n`);
  const evidence = { relativePath: input.relativePath, token };
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      input.mutation,
      "planned",
      "controller",
      evidence,
    ),
  );
  context.peerJournal.append(
    entry(
      context,
      input.operationId,
      input.mutation,
      "started",
      "peer",
      evidence,
    ),
  );
  const payload = `${input.mutation} payload\n${token}\n`;
  if (input.mutation === "append") appendFileSync(destination, payload);
  else writeFileSync(destination, payload);
  const digest = sha256(readFileSync(destination));
  const observed = { ...evidence, digest };
  context.peerJournal.append(
    entry(
      context,
      input.operationId,
      input.mutation,
      "observed",
      "peer",
      observed,
    ),
  );
  context.peerJournal.append(
    entry(
      context,
      input.operationId,
      input.mutation,
      "completed",
      "peer",
      observed,
    ),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      input.mutation,
      "completed",
      "controller",
      observed,
    ),
  );
  return { token, digest };
}

/** Creates a canary and records the rename destination as its required path. */
export function renameCanary(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly sourcePath: string;
    readonly relativePath: string;
  },
): { readonly token: string; readonly digest: string } {
  assertSafeRelativePath(input.sourcePath);
  assertSafeRelativePath(input.relativePath);
  const token = `CFS:${context.runId}:${input.operationId}:${context.peer}`;
  const evidence = { relativePath: input.relativePath, token };
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "rename",
      "planned",
      "controller",
      evidence,
    ),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "rename", "started", "peer", evidence),
  );
  const repositoryPath = join(context.peerPaths.workspace, context.repository);
  const source = join(repositoryPath, input.sourcePath);
  const destination = join(repositoryPath, input.relativePath);
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(destination), { recursive: true });
  const content = `rename payload\n${token}\n`;
  writeFileSync(source, content);
  renameSync(source, destination);
  const digest = sha256(content);
  const observed = { ...evidence, digest };
  context.peerJournal.append(
    entry(context, input.operationId, "rename", "observed", "peer", observed),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "rename", "completed", "peer", observed),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "rename",
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
  const token = `CFS:${context.runId}:${input.operationId}:${context.peer}`;
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

export function deletePath(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly relativePath: string;
  },
): void {
  assertSafeRelativePath(input.relativePath);
  const evidence = {
    relativePath: input.relativePath,
    detail: "delete-intent",
  };
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "delete",
      "planned",
      "controller",
      evidence,
    ),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "delete", "started", "peer", evidence),
  );
  rmSync(
    join(context.peerPaths.workspace, context.repository, input.relativePath),
    { recursive: true, force: false },
  );
  context.peerJournal.append(
    entry(context, input.operationId, "delete", "observed", "peer", evidence),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "delete", "completed", "peer", evidence),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "delete",
      "completed",
      "controller",
      evidence,
    ),
  );
}

export function stagePath(
  context: OperationContext,
  input: {
    readonly operationId: string;
    readonly relativePath: string;
    readonly indexBackupRef?: string;
  },
): { readonly indexTree: string; readonly indexBackupRef?: string } {
  assertSafeRelativePath(input.relativePath);
  const basic = { relativePath: input.relativePath };
  context.controllerJournal?.append(
    entry(context, input.operationId, "stage", "planned", "controller", basic),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "stage", "started", "peer", basic),
  );
  const repositoryPath = join(context.peerPaths.workspace, context.repository);
  git(repositoryPath, ["add", input.relativePath]);
  const indexTree = git(repositoryPath, ["write-tree"]).stdout.trim();
  if (input.indexBackupRef !== undefined)
    git(repositoryPath, ["update-ref", input.indexBackupRef, indexTree]);
  const observed = {
    ...basic,
    indexTree,
    ...(input.indexBackupRef === undefined
      ? {}
      : { indexBackupRef: input.indexBackupRef }),
  };
  context.peerJournal.append(
    entry(context, input.operationId, "stage", "observed", "peer", observed),
  );
  context.peerJournal.append(
    entry(context, input.operationId, "stage", "completed", "peer", observed),
  );
  context.controllerJournal?.append(
    entry(
      context,
      input.operationId,
      "stage",
      "completed",
      "controller",
      observed,
    ),
  );
  return {
    indexTree,
    ...(input.indexBackupRef === undefined
      ? {}
      : { indexBackupRef: input.indexBackupRef }),
  };
}

export type { OperationContext };
