import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureLive, prepareLive, runLiveScenario } from "../src/live.js";
import type {
  HarnessConfig,
  ScenarioMode,
  ScenarioName,
} from "../src/types.js";

test("native live adapter runs all three scenarios across isolated clients", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-native-live-"));
  try {
    const config = localFleetConfig(temporary);
    const scenarios: readonly [ScenarioName, ScenarioMode, number][] = [
      ["serial", "raw", 55101],
      ["conflict", "raw", 55102],
      ["churn", "guarded", 55103],
    ];
    for (const [scenario, mode, seed] of scenarios) {
      const runId = `native-${scenario}`;
      prepareLive(config, runId, seed);
      const folderId = await configureLive(config, runId);
      assert.match(folderId, /^[a-f0-9-]{16,64}$/u);
      const result = await runLiveScenario({
        config,
        runId,
        scenario,
        mode,
        seed,
      });
      assert.equal(result.verdict, "pass", JSON.stringify(result, null, 2));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function localFleetConfig(base: string): HarnessConfig {
  const peers = (["alpha", "beta", "gamma"] as const).map((name) => {
    const parent = join(base, name);
    mkdirSync(parent, { recursive: true });
    return {
      name,
      host: "local" as const,
      runBase: join(parent, "runs"),
      nodeBinary: process.execPath,
    };
  });
  return {
    quietSamples: 2,
    quietIntervalMs: 1,
    convergenceTimeoutMs: 30_000,
    peers,
  };
}
