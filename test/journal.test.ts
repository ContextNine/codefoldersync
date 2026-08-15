import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableJournal,
  readJournal,
  reconcileJournals,
} from "../src/journal.js";
import type { JournalEntry } from "../src/types.js";

function entry(
  phase: JournalEntry["phase"],
  source: JournalEntry["source"],
  digest?: string,
): JournalEntry {
  return {
    schemaVersion: 1,
    runId: "journal-run",
    operationId: "operation-1",
    timestamp: "2026-08-15T00:00:00.000Z",
    peer: "alpha",
    repository: "atlas",
    action: "write",
    phase,
    source,
    ...(digest === undefined ? {} : { digest }),
  };
}

test("peer evidence closes a lost controller acknowledgement window", () => {
  const result = reconcileJournals(
    [entry("planned", "controller")],
    [entry("started", "peer"), entry("observed", "peer", "digest-1")],
  );
  assert.equal(result.required.length, 1);
  assert.deepEqual(result.ambiguousOperationIds, []);
  assert.equal(result.required[0]?.digest, "digest-1");
});

test("started operations without post-state remain ambiguous", () => {
  const result = reconcileJournals(
    [entry("planned", "controller")],
    [entry("started", "peer")],
  );
  assert.deepEqual(result.ambiguousOperationIds, ["operation-1"]);
});

test("an explicitly interrupted operation is not treated as completed or ambiguous", () => {
  const result = reconcileJournals(
    [entry("planned", "controller")],
    [entry("started", "peer"), entry("interrupted", "peer")],
  );
  assert.deepEqual(result.required, []);
  assert.deepEqual(result.ambiguousOperationIds, []);
});

test("controller and peer evidence disagreement is visible", () => {
  const result = reconcileJournals(
    [entry("completed", "controller", "digest-a")],
    [entry("completed", "peer", "digest-b")],
  );
  assert.deepEqual(result.disagreements, ["operation-1"]);
});

test("durable journals round-trip entries", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-journal-"));
  try {
    const path = join(temporary, "journal.jsonl");
    const journal = new DurableJournal(path);
    journal.append(entry("planned", "controller"));
    journal.append(entry("started", "peer"));
    journal.close();
    assert.equal(readJournal(path).length, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
