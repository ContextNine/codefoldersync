import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFixture } from "../src/fixture.js";
import { DurableJournal, readJournal } from "../src/journal.js";
import { createCommit, writeCanary } from "../src/operations.js";
import { createRunRoot } from "../src/paths.js";
import { git } from "../src/git.js";
import { verifyPeer } from "../src/verifier.js";

test("verifier detects lost bytes and lost ref meaning", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-verify-"));
  try {
    const controllerPaths = createRunRoot(
      join(temporary, "controller"),
      "verify-run",
    );
    const peerPaths = createRunRoot(join(temporary, "peer"), "verify-run");
    createFixture(peerPaths.workspace, 17);
    const controllerJournal = new DurableJournal(
      join(controllerPaths.control, "controller.jsonl"),
    );
    const peerJournal = new DurableJournal(
      join(peerPaths.control, "peer.jsonl"),
    );
    const context = {
      runId: "verify-run",
      peer: "alpha" as const,
      repository: "atlas" as const,
      controllerJournal,
      peerJournal,
      peerPaths,
    };
    writeCanary(context, {
      operationId: "lost-file",
      relativePath: "lost.txt",
    });
    const commit = createCommit(context, {
      operationId: "lost-ref",
      branch: "verify/lost-ref",
      relativePath: "commits/lost-ref.txt",
      backupRef: "refs/treesync-harness/alpha/lost-ref",
    });
    controllerJournal.close();
    peerJournal.close();
    rmSync(join(peerPaths.workspace, "atlas", "lost.txt"));
    const main = git(join(peerPaths.workspace, "atlas"), [
      "rev-parse",
      "main",
    ]).stdout.trim();
    git(join(peerPaths.workspace, "atlas"), [
      "update-ref",
      commit.refName,
      main,
    ]);
    git(join(peerPaths.workspace, "atlas"), [
      "update-ref",
      "-d",
      "refs/treesync-harness/alpha/lost-ref",
    ]);
    const result = verifyPeer({
      paths: peerPaths,
      controllerEntries: readJournal(
        join(controllerPaths.control, "controller.jsonl"),
      ),
      peerEntries: readJournal(join(peerPaths.control, "peer.jsonl")),
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.code === "missing-token"));
    assert.ok(result.issues.some((issue) => issue.code === "lost-ref-meaning"));
    assert.ok(
      result.issues.some((issue) => issue.code === "missing-backup-ref"),
    );
    assert.equal(
      git(join(peerPaths.workspace, "atlas"), [
        "cat-file",
        "-e",
        `${commit.commitOid}^{commit}`,
      ]).status,
      0,
      "the object survives, proving object presence alone is insufficient",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
