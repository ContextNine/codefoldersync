import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("visibility observer exits when its controller channel closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-visibility-life-"));
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    const runId = "visibility-lifetime-test";
    const workspace = join(root, "Code", "fixture");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(root, "SENTINEL"), `${runId}\n`);
    writeFileSync(join(workspace, "index.ts"), "export {};\n");
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "product-cli.ts"),
        "visibility-agent",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const firstLine = waitForFirstLine(child);
    child.stdin.write(
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        allowedRunRoot: root,
        workspace,
        pollIntervalMs: 25,
        timeoutMs: 60_000,
      })}\n`,
    );
    const ready = JSON.parse(await withTimeout(firstLine, 5_000)) as {
      readonly kind: string;
    };
    assert.equal(ready.kind, "ready");
    assert.equal(child.exitCode, null);

    const closed = waitForClose(child);
    child.stdin.end();
    assert.equal(await withTimeout(closed, 5_000), 0);
    assert.equal(stderr, "");
  } finally {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
    if (existsSync(root)) rmSync(root, { force: true, recursive: true });
  }
});

function waitForFirstLine(
  child: ChildProcessWithoutNullStreams,
): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    const onData = (chunk: string): void => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolveLine(output.slice(0, newline));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Observer closed before its ready event"));
    };
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveClose(status ?? -1));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolveValue, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for observer lifecycle")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
