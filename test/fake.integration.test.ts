import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFakeScenario } from "../src/fake.js";
import type { ScenarioMode, ScenarioName } from "../src/types.js";

const cases: readonly [ScenarioName, ScenarioMode][] = [
  ["serial", "raw"],
  ["conflict", "raw"],
  ["conflict", "guarded"],
  ["churn", "guarded"],
];

for (const [scenario, mode] of cases) {
  test(`fake ${scenario} ${mode} preserves every completed operation`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "treesync-fake-"));
    try {
      const result = runFakeScenario({
        base: temporary,
        runId: `${scenario}-${mode}`,
        scenario,
        mode,
        seed: 84,
      });
      assert.equal(result.verdict, "pass");
      for (const verification of Object.values(result.verification)) {
        assert.equal(verification.passed, true);
        assert.equal(
          verification.recoveredOperations,
          verification.requiredOperations,
        );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("injected completed-operation loss is rejected on every peer", () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-fake-loss-"));
  try {
    const result = runFakeScenario({
      base: temporary,
      runId: "injected-loss",
      scenario: "serial",
      mode: "raw",
      seed: 85,
      injectLoss: true,
    });
    assert.equal(result.verdict, "product-failure");
    for (const verification of Object.values(result.verification)) {
      assert.equal(verification.passed, false);
      assert.ok(
        verification.issues.some((issue) => issue.code === "missing-token"),
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
