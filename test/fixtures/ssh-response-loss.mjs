import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const [binary, runId, allowedRunRoot, markerPath, dropAction, ...binaryArgs] =
  process.argv.slice(2);
assert.ok(binary && runId && allowedRunRoot && markerPath && dropAction);
const runRoot = resolve(allowedRunRoot);
const sentinel = join(runRoot, "SENTINEL");
assert.equal(readFileSync(sentinel, "utf8"), `${runId}\n`);
const runStat = lstatSync(runRoot);
assert.equal(runStat.isDirectory() && !runStat.isSymbolicLink(), true);
assertContained(markerPath, runRoot);

const input = await readStdin();
const request = JSON.parse(input);
assert.equal(typeof request, "object");
assert.ok(
  ["inspect", "setup-authority", "seal-source", "verify"].includes(
    request.action,
  ),
);
if (request.action === "setup-authority") {
  assertContained(request.root, runRoot);
  assertContained(request.stateDir, runRoot);
  assertContained(request.configPath, runRoot);
  assert.equal(request.hub.kind, "local");
  assertContained(request.hub.path, runRoot);
  const source = join(request.root, "source.ts");
  mkdirSync(request.root, { recursive: true, mode: 0o700 });
  const content = "export const responseLossFixture = true;\n";
  if (existsSync(source)) assert.equal(readFileSync(source, "utf8"), content);
  else
    writeFileSync(source, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
} else if ("configPath" in request) {
  assertContained(request.configPath, runRoot);
}

const child = spawnSync(binary, binaryArgs, {
  input,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (child.status !== 0) {
  process.stderr.write(
    child.stderr || child.error?.message || "agent failed\n",
  );
  process.exitCode = child.status ?? 2;
} else if (request.action === dropAction && !existsSync(markerPath)) {
  writeFileSync(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, runId, action: dropAction })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  process.exitCode = 75;
} else process.stdout.write(child.stdout);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function assertContained(path, root) {
  const target = resolve(path);
  assert.equal(target === root || target.startsWith(`${root}${sep}`), true);
}
