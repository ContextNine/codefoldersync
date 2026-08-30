import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashText } from "../v2/hash.js";
import {
  aiPathStateDigest,
  aiWorkspaceDigest,
  changedAiWorkspacePaths,
  snapshotAiWorkspace,
} from "./ai-workload.js";

export interface VisibilityObserverSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly allowedRunRoot: string;
  readonly workspace: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
}

export type VisibilityEvent =
  | {
      readonly kind: "ready";
      readonly sequence: 0;
      readonly treeDigest: string;
    }
  | {
      readonly kind: "change";
      readonly sequence: number;
      readonly pathHash: string;
      readonly stateDigest: string | null;
      readonly treeDigest: string;
    }
  | {
      readonly kind: "timeout";
      readonly sequence: number;
      readonly treeDigest: string;
    };

/** Streams path hashes and content-state digests. The receiving controller
 * supplies all accepted timing by timestamping each line as it arrives. */
export async function runVisibilityObserver(
  spec: VisibilityObserverSpec,
  emit: (event: VisibilityEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  validateVisibilitySpec(spec);
  let previous = snapshotAiWorkspace(spec.workspace);
  let sequence = 0;
  emit({
    kind: "ready",
    sequence: 0,
    treeDigest: aiWorkspaceDigest(previous),
  });
  const deadline = Date.now() + spec.timeoutMs;
  while (!isAborted(signal) && Date.now() < deadline) {
    await delay(spec.pollIntervalMs, undefined, { signal }).catch(
      () => undefined,
    );
    if (isAborted(signal)) return;
    const current = snapshotAiWorkspace(spec.workspace);
    const treeDigest = aiWorkspaceDigest(current);
    for (const path of changedAiWorkspacePaths(previous, current)) {
      sequence += 1;
      emit({
        kind: "change",
        sequence,
        pathHash: hashText(path),
        stateDigest: aiPathStateDigest(current[path]),
        treeDigest,
      });
    }
    previous = current;
  }
  if (!isAborted(signal))
    emit({
      kind: "timeout",
      sequence,
      treeDigest: aiWorkspaceDigest(previous),
    });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export function readVisibilityObserverSpec(
  value: unknown,
): VisibilityObserverSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Visibility observer specification must be an object");
  const spec = value as VisibilityObserverSpec;
  validateVisibilitySpec(spec);
  return spec;
}

function validateVisibilitySpec(spec: VisibilityObserverSpec): void {
  if (spec.schemaVersion !== 1)
    throw new Error("Visibility observer schema is unsupported");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(spec.runId))
    throw new Error("Visibility observer run ID is invalid");
  if (!isAbsolute(spec.allowedRunRoot) || !isAbsolute(spec.workspace))
    throw new Error("Visibility observer roots must be absolute");
  const runRoot = resolve(spec.allowedRunRoot);
  const workspace = resolve(spec.workspace);
  if (!workspace.startsWith(`${runRoot}${sep}`))
    throw new Error("Visibility observer workspace escapes its run root");
  const sentinel = join(runRoot, "SENTINEL");
  if (
    !existsSync(sentinel) ||
    readFileSync(sentinel, "utf8").trim() !== spec.runId
  )
    throw new Error("Visibility observer sentinel does not match the run");
  if (!existsSync(workspace))
    throw new Error("Visibility observer workspace is missing");
  if (
    !Number.isInteger(spec.pollIntervalMs) ||
    spec.pollIntervalMs < 10 ||
    !Number.isInteger(spec.timeoutMs) ||
    spec.timeoutMs < 1_000
  )
    throw new Error("Visibility observer timing is invalid");
}
