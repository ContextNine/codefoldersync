import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import type { JournalEntry, RequiredOperation } from "./types.js";

export class DurableJournal {
  readonly #descriptor: number;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.#descriptor = openSync(path, "a", 0o600);
  }

  append(entry: JournalEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    writeSync(this.#descriptor, line, undefined, "utf8");
    fsyncSync(this.#descriptor);
  }

  close(): void {
    closeSync(this.#descriptor);
  }
}

export function readJournal(path: string): readonly JournalEntry[] {
  const content = readFileSync(path, "utf8");
  if (content.length === 0) return [];
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => parseJournalEntry(line, index + 1));
}

function parseJournalEntry(line: string, lineNumber: number): JournalEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSON in journal line ${lineNumber}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("operationId" in value) ||
    typeof value.operationId !== "string" ||
    !("phase" in value) ||
    typeof value.phase !== "string" ||
    !("source" in value) ||
    (value.source !== "controller" && value.source !== "peer")
  ) {
    throw new Error(`Invalid journal entry at line ${lineNumber}`);
  }
  return value as JournalEntry;
}

export interface ReconciledJournal {
  readonly required: readonly RequiredOperation[];
  readonly ambiguousOperationIds: readonly string[];
  readonly disagreements: readonly string[];
}

export function reconcileJournals(
  controller: readonly JournalEntry[],
  peerEntries: readonly JournalEntry[],
): ReconciledJournal {
  const all = [...controller, ...peerEntries];
  const grouped = new Map<string, JournalEntry[]>();
  for (const journalEntry of all) {
    const entries = grouped.get(journalEntry.operationId) ?? [];
    entries.push(journalEntry);
    grouped.set(journalEntry.operationId, entries);
  }
  const required: RequiredOperation[] = [];
  const ambiguousOperationIds: string[] = [];
  const disagreements: string[] = [];

  for (const [operationId, entries] of grouped) {
    const observed = entries.filter(
      (entry) => entry.phase === "observed" || entry.phase === "completed",
    );
    const peerObserved = observed.filter((entry) => entry.source === "peer");
    const controllerObserved = observed.filter(
      (entry) => entry.source === "controller",
    );
    const evidence = peerObserved.at(-1) ?? controllerObserved.at(-1);
    if (evidence !== undefined) {
      const fingerprints = new Set(
        observed.map((entry) =>
          JSON.stringify({
            token: entry.token,
            digest: entry.digest,
            commitOid: entry.commitOid,
            refName: entry.refName,
            backupRef: entry.backupRef,
          }),
        ),
      );
      if (fingerprints.size > 1) disagreements.push(operationId);
      required.push({
        operationId,
        peer: evidence.peer,
        repository: evidence.repository,
        ...(evidence.token === undefined ? {} : { token: evidence.token }),
        ...(evidence.digest === undefined ? {} : { digest: evidence.digest }),
        ...(evidence.commitOid === undefined
          ? {}
          : { commitOid: evidence.commitOid }),
        ...(evidence.refName === undefined
          ? {}
          : { refName: evidence.refName }),
        ...(evidence.backupRef === undefined
          ? {}
          : { backupRef: evidence.backupRef }),
      });
      continue;
    }
    if (
      entries.some((entry) => entry.phase === "started") &&
      !entries.some((entry) => entry.phase === "interrupted")
    ) {
      ambiguousOperationIds.push(operationId);
    }
  }

  return { required, ambiguousOperationIds, disagreements };
}
