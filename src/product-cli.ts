#!/usr/bin/env node

import { hostname } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseHubRequest } from "./product/codec.js";
import {
  defaultConfigPath,
  ensureLocalLayout,
  loadProductConfig,
} from "./product/config.js";
import {
  history,
  listRecoveries,
  recoverSnapshot,
  resolveConflict,
  statusFolder,
  syncFolder,
} from "./product/engine.js";
import { handleHubRequest } from "./product/hub.js";
import {
  interactiveSetup,
  parseHubSpec,
  setupProduct,
} from "./product/setup.js";

const productVersion = "0.1.0";
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
    case undefined:
    case "help":
    case "--help":
      printHelp();
      return;
    case "--version":
    case "version":
      process.stdout.write(`codefoldersync ${productVersion}\n`);
      return;
    case "setup":
      await setup(args);
      return;
    case "sync":
      runSync(args);
      return;
    case "status":
      runStatus(args);
      return;
    case "doctor":
      runDoctor(args);
      return;
    case "daemon":
      await runDaemon(args);
      return;
    case "history":
      runHistory(args);
      return;
    case "conflicts":
      runConflicts(args);
      return;
    case "resolve":
      runResolve(args);
      return;
    case "recover":
      runRecover(args);
      return;
    case "recoveries":
      runRecoveries(args);
      return;
    case "hub-rpc":
      await runHubRpc(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function setup(commandArgs: readonly string[]): Promise<void> {
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const root = option(commandArgs, "--root");
  const hubSpec = option(commandArgs, "--hub");
  if (root === undefined || hubSpec === undefined) {
    const config = await interactiveSetup(configPath);
    process.stdout.write(`${JSON.stringify(setupResult(config), null, 2)}\n`);
    return;
  }
  const mode = option(commandArgs, "--mode") ?? "create";
  if (mode !== "create" && mode !== "join")
    throw new Error("Mode must be create or join");
  const remoteCommand =
    option(commandArgs, "--remote-command") ?? "codefoldersync";
  const remoteNode = option(commandArgs, "--remote-node");
  const folderId = option(commandArgs, "--folder-id");
  const stateDir = option(commandArgs, "--state");
  const config = setupProduct({
    mode,
    root,
    folderName: option(commandArgs, "--name") ?? "code",
    ...(folderId === undefined ? {} : { folderId }),
    peerName: option(commandArgs, "--peer") ?? hostname(),
    ...(stateDir === undefined ? {} : { stateDir }),
    configPath,
    hub: parseHubSpec(
      hubSpec,
      remoteNode === undefined ? [remoteCommand] : [remoteNode, remoteCommand],
    ),
  });
  process.stdout.write(`${JSON.stringify(setupResult(config), null, 2)}\n`);
}

function runSync(commandArgs: readonly string[]): void {
  const results = syncFolder(load(commandArgs));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (
    results.some(
      (result) =>
        result.action === "blocked" || result.action === "inconclusive",
    )
  ) {
    process.exitCode = 1;
  }
}

function runStatus(commandArgs: readonly string[]): void {
  const results = statusFolder(load(commandArgs));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (
    results.some(
      (result) =>
        result.status === "blocked" || result.status === "inconclusive",
    )
  ) {
    process.exitCode = 1;
  }
}

function runDoctor(commandArgs: readonly string[]): void {
  const config = load(commandArgs);
  ensureLocalLayout(config);
  const status = statusFolder(config);
  const result = {
    ready: status.every(
      (unit) => unit.status !== "blocked" && unit.status !== "inconclusive",
    ),
    version: productVersion,
    folderId: config.folderId,
    peerId: config.peerId,
    peerName: config.peerName,
    hub: config.hub.kind,
    units: status,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}

async function runDaemon(commandArgs: readonly string[]): Promise<void> {
  const config = load(commandArgs);
  const intervalSeconds = Number(option(commandArgs, "--interval") ?? "2");
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Daemon interval must be positive");
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  while (!controller.signal.aborted) {
    const results = syncFolder(config);
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), results })}\n`,
    );
    if (
      results.some(
        (result) =>
          result.action === "blocked" || result.action === "inconclusive",
      )
    ) {
      process.exitCode = 1;
      return;
    }
    try {
      await delay(intervalSeconds * 1000, undefined, {
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
}

function runHistory(commandArgs: readonly string[]): void {
  const unit = positional(commandArgs, 0);
  if (unit === undefined) throw new Error("History requires a repository name");
  const snapshots = history(load(commandArgs), unit).map((snapshot) => ({
    snapshotId: snapshot.snapshotId,
    parentId: snapshot.parentId,
    peerId: snapshot.peerId,
    createdAt: snapshot.createdAt,
    treeDigest: snapshot.treeDigest,
    files: snapshot.files.length,
  }));
  process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
}

function runConflicts(commandArgs: readonly string[]): void {
  const blocked = statusFolder(load(commandArgs)).filter(
    (unit) => unit.status === "blocked",
  );
  process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
  if (blocked.length > 0) process.exitCode = 1;
}

function runResolve(commandArgs: readonly string[]): void {
  const unit = positional(commandArgs, 0);
  if (unit === undefined) throw new Error("Resolve requires a repository name");
  const take = option(commandArgs, "--take");
  if (take !== "local" && take !== "remote") {
    throw new Error("Resolve requires --take local or --take remote");
  }
  const result = resolveConflict(load(commandArgs), unit, take);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.action === "blocked" || result.action === "inconclusive")
    process.exitCode = 1;
}

function runRecover(commandArgs: readonly string[]): void {
  const snapshotId = positional(commandArgs, 0);
  const destination = option(commandArgs, "--to");
  if (snapshotId === undefined || destination === undefined) {
    throw new Error("Recover requires <snapshot-id> --to <empty-path>");
  }
  recoverSnapshot(load(commandArgs), snapshotId, resolve(destination));
  process.stdout.write(`${resolve(destination)}\n`);
}

function runRecoveries(commandArgs: readonly string[]): void {
  process.stdout.write(
    `${JSON.stringify(listRecoveries(load(commandArgs)), null, 2)}\n`,
  );
}

async function runHubRpc(commandArgs: readonly string[]): Promise<void> {
  const encoded = option(commandArgs, "--hub-base64");
  if (encoded === undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("hub-rpc requires a valid --hub-base64 value");
  }
  const hub = Buffer.from(encoded, "base64url").toString("utf8");
  try {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    const request = parseHubRequest(JSON.parse(input) as unknown);
    const value = handleHubRequest(hub, request);
    process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

function load(commandArgs: readonly string[]) {
  return loadProductConfig(
    resolve(option(commandArgs, "--config") ?? defaultConfigPath()),
  );
}

function setupResult(config: ReturnType<typeof loadProductConfig>) {
  return {
    configured: true,
    folderId: config.folderId,
    folderName: config.folderName,
    peerId: config.peerId,
    peerName: config.peerName,
    root: config.root,
    units: config.units,
    hub: config.hub.kind,
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function positional(
  args: readonly string[],
  index: number,
): string | undefined {
  const values: string[] = [];
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const value = args[cursor];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      cursor += 1;
      continue;
    }
    values.push(value);
  }
  return values[index];
}

function printHelp(): void {
  process.stdout.write(`CodeFolderSync ${productVersion}

No account or signup. Peers use your existing SSH access.

Commands:
  codefoldersync setup
  codefoldersync setup --mode <create|join> --root <path> --hub <path|ssh-url> [options]
  codefoldersync doctor [--config <path>]
  codefoldersync status [--config <path>]
  codefoldersync sync [--config <path>]
  codefoldersync daemon [--config <path>] [--interval <seconds>]
  codefoldersync history <repository> [--config <path>]
  codefoldersync conflicts [--config <path>]
  codefoldersync resolve <repository> --take <local|remote> [--config <path>]
  codefoldersync recover <snapshot-id> --to <empty-path> [--config <path>]
  codefoldersync recoveries [--config <path>]
`);
}
