import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFixture } from "../src/fixture.js";
import { DurableJournal, readJournal } from "../src/journal.js";
import {
  createCommit,
  deletePath,
  stagePath,
  writeCanary,
} from "../src/operations.js";
import { createRunRoot } from "../src/paths.js";
import { git } from "../src/git.js";
import { enforcePeerAgreement, verifyPeer } from "../src/verifier.js";
import type { VerificationResult } from "../src/types.js";

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

test("cross-peer Git semantic divergence prevents a pass", () => {
  const base: VerificationResult = {
    passed: true,
    manifestDigest: "same-files",
    gitSemanticDigest: "git-a",
    classifications: [],
    issues: [],
    requiredOperations: 0,
    recoveredOperations: 0,
  };
  const result = enforcePeerAgreement({
    alpha: base,
    beta: { ...base, gitSemanticDigest: "git-b" },
    gamma: base,
  });
  assert.equal(result.alpha.passed, false);
  assert.ok(
    result.gamma.issues.some((issue) => issue.code === "peer-git-divergence"),
  );
});

test("verifier classifies preserved delete conflicts and backed-up index trees", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-semantics-"));
  try {
    const controllerPaths = createRunRoot(
      join(temporary, "controller"),
      "semantic-run",
    );
    const peerPaths = createRunRoot(join(temporary, "peer"), "semantic-run");
    createFixture(peerPaths.workspace, 29);
    const controllerJournal = new DurableJournal(
      join(controllerPaths.control, "controller.jsonl"),
    );
    const peerJournal = new DurableJournal(
      join(peerPaths.control, "peer.jsonl"),
    );
    const context = {
      runId: "semantic-run",
      peer: "alpha" as const,
      repository: "atlas" as const,
      controllerJournal,
      peerJournal,
      peerPaths,
    };
    deletePath(context, {
      operationId: "delete-with-concurrent-write",
      relativePath: "docs/modify-delete.md",
    });
    writeCanary(context, {
      operationId: "concurrent-write",
      relativePath: "docs/modify-delete.md",
    });
    writeCanary(context, {
      operationId: "staged-payload",
      relativePath: "preserved-index.txt",
    });
    stagePath(context, {
      operationId: "preserved-index",
      relativePath: "preserved-index.txt",
      indexBackupRef: "refs/treesync-harness/index/alpha",
    });
    git(join(peerPaths.workspace, "atlas"), ["reset"]);
    controllerJournal.close();
    peerJournal.close();

    const result = verifyPeer({
      paths: peerPaths,
      controllerEntries: readJournal(
        join(controllerPaths.control, "controller.jsonl"),
      ),
      peerEntries: readJournal(join(peerPaths.control, "peer.jsonl")),
    });
    assert.equal(result.passed, true);
    assert.ok(
      result.classifications.includes(
        "delete-conflict-retained-data:delete-with-concurrent-write",
      ),
    );
    assert.ok(
      result.classifications.includes(
        "index-tree-preserved-by-backup:preserved-index",
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("verifier rejects unapplied deletes, altered canaries, and lost index meaning", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-loss-"));
  try {
    const controllerPaths = createRunRoot(
      join(temporary, "controller"),
      "loss-run",
    );
    const peerPaths = createRunRoot(join(temporary, "peer"), "loss-run");
    createFixture(peerPaths.workspace, 31);
    const controllerJournal = new DurableJournal(
      join(controllerPaths.control, "controller.jsonl"),
    );
    const peerJournal = new DurableJournal(
      join(peerPaths.control, "peer.jsonl"),
    );
    const context = {
      runId: "loss-run",
      peer: "alpha" as const,
      repository: "atlas" as const,
      controllerJournal,
      peerJournal,
      peerPaths,
    };
    deletePath(context, {
      operationId: "unapplied-delete",
      relativePath: "src/nested/file-6.txt",
    });
    writeFileSync(
      join(peerPaths.workspace, "atlas", "src/nested/file-6.txt"),
      "silently restored\n",
    );
    const altered = writeCanary(context, {
      operationId: "altered-canary",
      relativePath: "altered.txt",
    });
    writeFileSync(
      join(peerPaths.workspace, "atlas", "altered.txt"),
      `${altered.token}\naltered bytes\n`,
    );
    writeCanary(context, {
      operationId: "misplaced-canary",
      relativePath: "expected.txt",
    });
    renameSync(
      join(peerPaths.workspace, "atlas", "expected.txt"),
      join(peerPaths.workspace, "atlas", "unexplained-move.txt"),
    );
    writeCanary(context, {
      operationId: "staged-payload",
      relativePath: "lost-index.txt",
    });
    stagePath(context, {
      operationId: "lost-index",
      relativePath: "lost-index.txt",
    });
    git(join(peerPaths.workspace, "atlas"), ["reset"]);
    controllerJournal.close();
    peerJournal.close();

    const result = verifyPeer({
      paths: peerPaths,
      controllerEntries: readJournal(
        join(controllerPaths.control, "controller.jsonl"),
      ),
      peerEntries: readJournal(join(peerPaths.control, "peer.jsonl")),
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.issues.some((issue) => issue.code === "delete-intent-not-applied"),
    );
    assert.ok(result.issues.some((issue) => issue.code === "altered-canary"));
    assert.ok(
      result.issues.some((issue) => issue.code === "unexpected-canary-path"),
    );
    assert.ok(
      result.issues.some((issue) => issue.code === "lost-index-meaning"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
