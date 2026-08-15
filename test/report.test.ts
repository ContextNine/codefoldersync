import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeMarkdownReport } from "../src/report.js";
import type { ScenarioResult, VerificationResult } from "../src/types.js";

test("report summarizes machine-readable verification without raw logs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-report-"));
  try {
    const verification: VerificationResult = {
      passed: true,
      manifestDigest: "digest",
      gitSemanticDigest: "git-digest",
      classifications: [],
      issues: [],
      requiredOperations: 3,
      recoveredOperations: 3,
    };
    const result: ScenarioResult = {
      schemaVersion: 1,
      runId: "report-run",
      scenario: "serial",
      mode: "raw",
      adapter: "fake",
      seed: 1,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      verdict: "pass",
      verification: {
        alpha: verification,
        beta: verification,
        gamma: verification,
      },
      notes: [],
    };
    const resultPath = join(temporary, "result.json");
    writeFileSync(resultPath, JSON.stringify(result));
    const reportPath = writeMarkdownReport(resultPath);
    const report = readFileSync(reportPath, "utf8");
    assert.match(report, /Verdict: `pass`/);
    assert.match(report, /\| alpha \| yes \| 3 \| 3 \| none \|/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
