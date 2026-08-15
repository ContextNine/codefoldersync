import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { superviseProcess } from "../src/supervisor.js";

test("expired heartbeat terminates work before its delayed write", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "treesync-supervisor-"));
  try {
    const heartbeat = join(temporary, "heartbeat.json");
    const output = join(temporary, "must-not-exist.txt");
    writeFileSync(
      heartbeat,
      `${JSON.stringify({ expiresAt: Date.now() + 100 })}\n`,
    );
    const script = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 2000)`;
    const result = await superviseProcess({
      command: process.execPath,
      args: ["-e", script, output],
      heartbeatPath: heartbeat,
      pollIntervalMs: 20,
      terminationGraceMs: 100,
    });
    assert.equal(result.terminatedForExpiredHeartbeat, true);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
