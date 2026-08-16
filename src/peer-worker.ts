#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.js";
import { digestGitSnapshots, git, snapshotGit } from "./git.js";
import { DurableJournal, readJournal } from "./journal.js";
import { buildManifest, digestManifest } from "./manifest.js";
import {
  createCommit,
  deletePath,
  mutateCanary,
  renameCanary,
  stagePath,
  writeCanary,
} from "./operations.js";
import { validateRunRoot } from "./paths.js";
import {
  peerNames,
  repositoryNames,
  type PeerName,
  type RepositoryName,
} from "./types.js";
import { verifyPeer } from "./verifier.js";
import { superviseProcess } from "./supervisor.js";

const [command, ...args] = process.argv.slice(2);

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

async function main(): Promise<void> {
  switch (command) {
    case "fixture":
      fixture(args);
      break;
    case "write":
      write(args);
      break;
    case "commit":
      commit(args);
      break;
    case "delete":
      remove(args);
      break;
    case "stage":
      stage(args);
      break;
    case "chmod-executable":
      chmodExecutable(args);
      break;
    case "churn":
      churn(args);
      break;
    case "snapshot":
      snapshot(args);
      break;
    case "verify":
      verify(args);
      break;
    case "capabilities":
      capabilities(args);
      break;
    case "delayed-write":
      delayedWrite(args);
      break;
    case "supervise-expiry-probe":
      await superviseExpiryProbe(args);
      break;
    case "codefoldersync-service":
      codefoldersyncService(args);
      break;
    default:
      throw new Error(`Unknown peer-worker command: ${command ?? ""}`);
  }
}

function codefoldersyncService(args: readonly string[]): void {
  const paths = pathsFrom(args);
  const action = requiredOption(args, "--action");
  const binary = requiredOption(args, "--binary");
  const home = requiredOption(args, "--home");
  if (!isAbsolute(binary) || !isAbsolute(home))
    throw new Error("Service binary and home must be absolute");
  const pidPath = join(paths.control, "codefoldersync-daemon.pid");
  const logPath = join(paths.control, "codefoldersync-daemon.log");
  const current = readDaemonPid(pidPath);
  const running =
    current !== undefined && daemonMatches(current, binary, false);

  if (action === "status") {
    output({ running, pid: running ? current : undefined });
    return;
  }
  if (action === "start") {
    if (running) {
      output({ running: true, pid: current });
      return;
    }
    if (current !== undefined)
      throw new Error("Stale or mismatched daemon PID; refusing to replace it");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const log = openSync(logPath, "a", 0o600);
    const child = spawn(binary, ["daemon", "--no-color"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, HOME: home },
    });
    closeSync(log);
    if (child.pid === undefined) throw new Error("Daemon did not return a PID");
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
    waitMilliseconds(500);
    if (!daemonMatches(child.pid, binary, false))
      throw new Error("Daemon exited during startup");
    output({ running: true, pid: child.pid });
    return;
  }
  if (action === "stop") {
    if (current === undefined) {
      output({ running: false });
      return;
    }
    if (!daemonMatches(current, binary, true))
      throw new Error(
        "PID does not identify the expected daemon; refusing kill",
      );
    process.kill(current, "SIGTERM");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!processExists(current)) break;
      waitMilliseconds(100);
    }
    if (processExists(current))
      throw new Error("Daemon did not stop after SIGTERM");
    rmSync(pidPath, { force: true });
    output({ running: false });
    return;
  }
  throw new Error(`Invalid service action: ${action}`);
}

function readDaemonPid(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    if (!Number.isSafeInteger(value) || value <= 1)
      throw new Error("Invalid daemon PID file");
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function daemonMatches(
  pid: number,
  binary: string,
  requireMatch: boolean,
): boolean {
  if (!processExists(pid)) return false;
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  const matches =
    command.status === 0 &&
    command.stdout.includes(binary) &&
    /(?:^|\s)daemon(?:\s|$)/.test(command.stdout);
  if (requireMatch && !matches) return false;
  return matches;
}

function waitMilliseconds(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fixture(args: readonly string[]): void {
  const paths = pathsFrom(args);
  if (readdirSync(paths.workspace).length !== 0)
    throw new Error("Workspace must be empty before fixture creation");
  createFixture(paths.workspace, integerOption(args, "--seed"));
  output({ manifestDigest: digestManifest(buildManifest(paths.workspace)) });
}

function write(args: readonly string[]): void {
  const context = contextFrom(args);
  const prefix = option(args, "--prefix");
  const result = writeCanary(context, {
    operationId: requiredOption(args, "--operation"),
    relativePath: requiredOption(args, "--path"),
    ...(prefix === undefined ? {} : { contentPrefix: prefix }),
  });
  context.peerJournal.close();
  output(result);
}

function commit(args: readonly string[]): void {
  const context = contextFrom(args);
  const backupRef = option(args, "--backup-ref");
  const result = createCommit(context, {
    operationId: requiredOption(args, "--operation"),
    branch: requiredOption(args, "--branch"),
    relativePath: requiredOption(args, "--path"),
    ...(backupRef === undefined ? {} : { backupRef }),
  });
  context.peerJournal.close();
  output(result);
}

function remove(args: readonly string[]): void {
  const context = contextFrom(args);
  deletePath(context, {
    operationId: requiredOption(args, "--operation"),
    relativePath: requiredOption(args, "--path"),
  });
  context.peerJournal.close();
  output({ detail: "delete-intent" });
}

function stage(args: readonly string[]): void {
  const context = contextFrom(args);
  const result = stagePath(context, {
    operationId: requiredOption(args, "--operation"),
    relativePath: requiredOption(args, "--path"),
  });
  context.peerJournal.close();
  output(result);
}

function chmodExecutable(args: readonly string[]): void {
  const context = contextFrom(args);
  chmodSync(
    join(
      context.peerPaths.workspace,
      context.repository,
      requiredOption(args, "--path"),
    ),
    0o755,
  );
  context.peerJournal.close();
  output({ executable: true });
}

function churn(args: readonly string[]): void {
  const context = contextFrom(args);
  const count = integerOption(args, "--count");
  const results: unknown[] = [];
  const repositoryPath = join(context.peerPaths.workspace, context.repository);
  const operationKinds = [
    "create",
    "rename",
    "chmod",
    "stage",
    "unstage",
    "append",
    "replace",
  ] as const;
  for (let index = 0; index < count; index += 1) {
    const operationId = `churn-${context.peer}-${index}`;
    const kind = index % operationKinds.length;
    const operationKind = operationKinds[kind];
    if (operationKind === undefined)
      throw new Error("Invalid churn operation kind");
    const relativePath = `churn/${context.peer}/operation-${index}.txt`;
    const result =
      operationKind === "rename"
        ? renameCanary(context, {
            operationId,
            sourcePath: relativePath,
            relativePath: `churn/${context.peer}/renamed-${index}.txt`,
          })
        : operationKind === "append" || operationKind === "replace"
          ? mutateCanary(context, {
              operationId,
              relativePath,
              mutation: operationKind,
            })
          : writeCanary(context, {
              operationId,
              relativePath,
              contentPrefix: operationKind,
            });
    if (kind === 2) {
      chmodSync(join(repositoryPath, relativePath), 0o755);
    } else if (kind === 3) {
      git(repositoryPath, ["add", relativePath]);
    } else if (kind === 4) {
      git(repositoryPath, ["add", relativePath]);
      git(repositoryPath, ["restore", "--staged", "--", relativePath]);
    }
    results.push({
      operationId,
      type:
        operationKind === "rename" ||
        operationKind === "append" ||
        operationKind === "replace"
          ? operationKind
          : "write",
      kind: operationKind,
      ...result,
    });
  }
  const deleteOperationId = `churn-${context.peer}-delete`;
  const deleteRelativePath = "src/nested/file-7.txt";
  deletePath(context, {
    operationId: deleteOperationId,
    relativePath: deleteRelativePath,
  });
  results.push({
    operationId: deleteOperationId,
    type: "delete",
    relativePath: deleteRelativePath,
  });
  const operationId = `churn-${context.peer}-commit`;
  const guarded = args.includes("--guarded");
  const backupRef = `refs/codefoldersync/${context.peer}/${operationId}`;
  results.push({
    operationId,
    type: "commit",
    ...createCommit(context, {
      operationId,
      branch: `churn/${context.peer}`,
      relativePath: `churn/${context.peer}/committed.txt`,
      ...(guarded ? { backupRef } : {}),
    }),
  });
  context.peerJournal.close();
  output(results);
}

function snapshot(args: readonly string[]): void {
  const paths = pathsFrom(args);
  const snapshots = repositoryNames.map((repository) =>
    snapshotGit(repository, join(paths.workspace, repository)),
  );
  output({
    manifestDigest: digestManifest(buildManifest(paths.workspace)),
    gitSemanticDigest: digestGitSnapshots(snapshots),
    repositories: Object.fromEntries(
      snapshots.map((repository) => [repository.repository, repository]),
    ),
  });
}

function verify(args: readonly string[]): void {
  const paths = pathsFrom(args);
  output(
    verifyPeer({
      paths,
      controllerEntries: readJournal(
        join(paths.control, requiredOption(args, "--controller-journal")),
      ),
      peerEntries: readJournal(
        join(paths.control, requiredOption(args, "--peer-journal")),
      ),
    }),
  );
}

function capabilities(args: readonly string[]): void {
  const paths = pathsFrom(args);
  const directory = join(paths.control, ".filesystem-capabilities");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
  const lower = join(directory, "case-probe");
  const upper = join(directory, "CASE-PROBE");
  writeFileSync(lower, "lower");
  let caseSensitive = true;
  try {
    writeFileSync(upper, "upper", { flag: "wx" });
  } catch {
    caseSensitive = false;
  }
  const composed = join(directory, "unicode-é");
  writeFileSync(composed, "unicode");
  const unicodeName =
    readdirSync(directory).find((name) => name.startsWith("unicode-")) ?? "";
  const value = {
    caseSensitive,
    unicodeName,
    unicodeBytes: Buffer.from(unicodeName).toString("hex"),
  };
  writeFileSync(
    join(paths.control, "filesystem-capabilities.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  rmSync(directory, { recursive: true, force: true });
  output(value);
}

function delayedWrite(args: readonly string[]): void {
  const context = contextFrom(args);
  const operationId = requiredOption(args, "--operation");
  const relativePath = requiredOption(args, "--path");
  context.peerJournal.append({
    schemaVersion: 1,
    runId: context.runId,
    operationId,
    timestamp: new Date().toISOString(),
    peer: context.peer,
    repository: context.repository,
    action: "write",
    phase: "started",
    source: "peer",
    relativePath,
  });
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    integerOption(args, "--delay-ms"),
  );
  writeCanary(context, { operationId, relativePath });
  context.peerJournal.close();
}

async function superviseExpiryProbe(args: readonly string[]): Promise<void> {
  const context = contextFrom(args);
  context.peerJournal.close();
  const operationId = requiredOption(args, "--operation");
  const relativePath = requiredOption(args, "--path");
  const heartbeat = requiredOption(args, "--heartbeat");
  const result = await superviseProcess({
    command: process.execPath,
    args: [
      fileURLToPath(import.meta.url),
      "delayed-write",
      "--run-base",
      requiredOption(args, "--run-base"),
      "--run",
      context.runId,
      "--peer",
      context.peer,
      "--repository",
      context.repository,
      "--operation",
      operationId,
      "--path",
      relativePath,
      "--delay-ms",
      requiredOption(args, "--child-delay-ms"),
    ],
    heartbeatPath: join(context.peerPaths.control, heartbeat),
    pollIntervalMs: 50,
    terminationGraceMs: 200,
  });
  if (!result.terminatedForExpiredHeartbeat)
    throw new Error(
      "Expiry probe child was not terminated by the heartbeat guard",
    );
  const journal = new DurableJournal(
    join(context.peerPaths.control, "peer.jsonl"),
  );
  journal.append({
    schemaVersion: 1,
    runId: context.runId,
    operationId,
    timestamp: new Date().toISOString(),
    peer: context.peer,
    repository: context.repository,
    action: "write",
    phase: "interrupted",
    source: "peer",
    relativePath,
    detail: "controller-heartbeat-expired",
  });
  journal.close();
  output(result);
}

function contextFrom(args: readonly string[]) {
  const paths = pathsFrom(args);
  const peer = requiredOption(args, "--peer");
  const repository = requiredOption(args, "--repository");
  if (!peerNames.includes(peer as PeerName))
    throw new Error(`Invalid peer ${peer}`);
  if (!repositoryNames.includes(repository as RepositoryName))
    throw new Error(`Invalid repository ${repository}`);
  return {
    runId: requiredOption(args, "--run"),
    peer: peer as PeerName,
    repository: repository as RepositoryName,
    peerJournal: new DurableJournal(join(paths.control, "peer.jsonl")),
    peerPaths: paths,
  };
}

function pathsFrom(args: readonly string[]) {
  return validateRunRoot(
    requiredOption(args, "--run-base"),
    requiredOption(args, "--run"),
  );
}

function integerOption(args: readonly string[], name: string): number {
  const value = Number(requiredOption(args, name));
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing ${name}`);
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
