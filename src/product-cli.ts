#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  defaultConfigPath,
  ensureLocalLayout,
  loadConfig,
  parseHubSpec,
} from "./v2/config.js";
import {
  historyV2,
  recoverManifestV2,
  resolveGitConflictV2,
  statusV2,
  syncFolderV2,
  V2SyncSession,
  verifyFullV2,
} from "./v2/engine.js";
import { ObjectStore } from "./v2/objects.js";
import { pullIgnoreRulesV2, pushIgnoreRulesV2 } from "./v2/ignore.js";
import {
  addRepositoryV2,
  refreshRepositoryMembershipV2,
  removeRepositoryV2,
} from "./v2/membership.js";
import {
  installSelf,
  activateInstalledVersion,
  installedVersions,
  installService,
  productVersion,
  restartService,
  serviceLogPaths,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "./v2/service.js";
import {
  interactiveSetupV2,
  setupProductV2,
  type SetupResult,
} from "./v2/setup.js";
import { serveHubStdio } from "./v2/transport.js";
import type { ProductConfig } from "./v2/types.js";

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
    case "install":
      runInstall(args);
      return;
    case "upgrade":
      runInstall(args);
      return;
    case "rollback":
      runRollback(args);
      return;
    case "setup":
      await runSetup(args);
      return;
    case "sync":
      await runSync(args);
      return;
    case "status":
      await runStatus(args);
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "daemon":
      await runDaemon(args);
      return;
    case "history":
      await runHistory(args);
      return;
    case "conflicts":
      await runConflicts(args);
      return;
    case "recover":
      await runRecover(args);
      return;
    case "resolve-git":
      await runResolveGit(args);
      return;
    case "verify":
      await runVerify(args);
      return;
    case "service":
      runService(args);
      return;
    case "repository":
      await runRepository(args);
      return;
    case "ignore":
      await runIgnore(args);
      return;
    case "hub":
      await runHub(args);
      return;
    case "gc":
      await runGc(args);
      return;
    case "migrate-v1":
      runMigrationInventory(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function runInstall(commandArgs: readonly string[]): void {
  const built = resolve(
    option(commandArgs, "--built") ?? dirname(fileURLToPath(import.meta.url)),
  );
  const installRoot = option(commandArgs, "--install-root");
  const bin = option(commandArgs, "--bin-dir");
  const result = installSelf({
    builtDirectory: built,
    ...(installRoot === undefined ? {} : { installRoot }),
    ...(bin === undefined ? {} : { binaryDirectory: bin }),
  });
  printJson({ installed: true, version: productVersion, ...result });
}

function runRollback(commandArgs: readonly string[]): void {
  const version = option(commandArgs, "--version");
  if (version === undefined) throw new Error("Rollback requires --version");
  const installRoot = option(commandArgs, "--install-root");
  const bin = option(commandArgs, "--bin-dir");
  const result = activateInstalledVersion({
    version,
    ...(installRoot === undefined ? {} : { installRoot }),
    ...(bin === undefined ? {} : { binaryDirectory: bin }),
  });
  printJson({
    activated: version,
    available: installedVersions(installRoot),
    ...result,
  });
}

async function runSetup(commandArgs: readonly string[]): Promise<void> {
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const root = option(commandArgs, "--root");
  const hubValue = option(commandArgs, "--hub");
  let result: SetupResult;
  let interactive = false;
  if (root === undefined || hubValue === undefined) {
    interactive = true;
    result = await interactiveSetupV2(configPath);
  } else {
    const mode = option(commandArgs, "--mode") ?? "create";
    if (mode !== "create" && mode !== "join")
      throw new Error("Setup mode must be create or join");
    const remoteCommand =
      option(commandArgs, "--remote-command") ?? "~/.local/bin/codefoldersync";
    const remoteNode = option(commandArgs, "--remote-node");
    const folderId = option(commandArgs, "--folder-id");
    const stateDir = option(commandArgs, "--state");
    result = await setupProductV2({
      mode,
      root,
      folderName: option(commandArgs, "--name") ?? "code",
      ...(folderId === undefined ? {} : { folderId }),
      peerName: option(commandArgs, "--peer") ?? hostname(),
      ...(stateDir === undefined ? {} : { stateDir }),
      configPath,
      hub: parseHubSpec(
        hubValue,
        remoteNode === undefined
          ? [remoteCommand]
          : [remoteNode, remoteCommand],
      ),
      initialSync: !flag(commandArgs, "--no-sync"),
    });
  }

  let service = null;
  if (
    flag(commandArgs, "--install-service") ||
    (interactive && (await askForService()))
  ) {
    const serviceCommand = defaultServiceCommand();
    service = installService(result.config, {
      configPath,
      ...serviceCommand,
    });
  }
  printJson({
    configured: true,
    folderId: result.config.folderId,
    peerId: result.config.peerId,
    root: result.config.root,
    repositories: result.config.repositories.map(
      (repository) => repository.name,
    ),
    filesystem: result.filesystem,
    sync: result.sync,
    service,
  });
}

async function runSync(commandArgs: readonly string[]): Promise<void> {
  const config = load(commandArgs);
  const result = await withExclusiveWriter(config, () => syncFolderV2(config));
  printJson(result);
  if (result.status === "offline" || result.status === "inconclusive")
    process.exitCode = 1;
}

async function runStatus(commandArgs: readonly string[]): Promise<void> {
  const result = await statusV2(load(commandArgs));
  printJson(result);
  if (
    result.summary.status === "offline" ||
    result.summary.status === "inconclusive"
  )
    process.exitCode = 1;
}

async function runDoctor(commandArgs: readonly string[]): Promise<void> {
  const config = load(commandArgs);
  ensureLocalLayout(config);
  const status = await statusV2(config);
  const result = {
    ready:
      status.summary.status !== "offline" &&
      status.summary.status !== "inconclusive",
    version: productVersion,
    protocolVersion: 2,
    folderId: config.folderId,
    peerId: config.peerId,
    peerName: config.peerName,
    root: config.root,
    stateDir: config.stateDir,
    hub: config.hub.kind,
    repositories: status.repositories,
    status: status.summary.status,
    reasons: status.summary.reasons,
  };
  printJson(result);
  if (!result.ready) process.exitCode = 1;
}

async function runDaemon(commandArgs: readonly string[]): Promise<void> {
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const config = loadConfig(configPath);
  ensureLocalLayout(config);
  const intervalMs = numberOption(
    commandArgs,
    "--interval-ms",
    config.service?.intervalMs ?? 150,
  );
  // Hub sequence checks are tiny and travel over the daemon's persistent
  // connection. A short poll keeps remote saves feeling immediate without
  // rescanning the workspace.
  const pollMs = numberOption(commandArgs, "--poll-ms", 250);
  const release = acquireDaemonLock(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  let fullReconcile = true;
  const dirtyPaths = new Set<string>();
  let lastRun = 0;
  let lastFullReconcile = 0;
  let session: V2SyncSession | null = null;
  const watcher = watch(
    config.root,
    { recursive: true },
    (_event, filename) => {
      if (filename === null) {
        fullReconcile = true;
      } else {
        dirtyPaths.add(String(filename).replaceAll("\\", "/"));
      }
    },
  );
  watcher.on("error", (error) => {
    process.stderr.write(`watcher degraded: ${error.message}\n`);
    fullReconcile = true;
  });
  try {
    while (!controller.signal.aborted) {
      const now = Date.now();
      if (
        lastFullReconcile > 0 &&
        now - lastFullReconcile >=
          (config.service?.reconcileSeconds ?? 600) * 1000 &&
        dirtyPaths.size === 0 &&
        now - lastRun >= 1_000
      ) {
        fullReconcile = true;
      }
      let remoteChanged = false;
      if (
        !fullReconcile &&
        dirtyPaths.size === 0 &&
        now - lastRun >= pollMs &&
        session !== null
      ) {
        try {
          remoteChanged = await session.hasRemoteChanges();
          if (!remoteChanged) lastRun = now;
        } catch {
          await session[Symbol.asyncDispose]();
          session = null;
        }
      }
      if (
        fullReconcile ||
        dirtyPaths.size > 0 ||
        remoteChanged ||
        session === null
      ) {
        if (fullReconcile || dirtyPaths.size > 0)
          await delay(intervalMs, undefined, {
            signal: controller.signal,
          }).catch(() => undefined);
        try {
          session ??= await V2SyncSession.connect(config);
        } catch (error) {
          process.stderr.write(
            `hub offline: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          lastRun = now;
          await delay(Math.min(pollMs, 1000), undefined, {
            signal: controller.signal,
          }).catch(() => undefined);
          continue;
        }
        const paths = fullReconcile ? undefined : [...dirtyPaths];
        fullReconcile = false;
        if (paths !== undefined)
          for (const path of paths) dirtyPaths.delete(path);
        const result =
          remoteChanged && paths !== undefined && paths.length === 0
            ? await session.pullRemote()
            : await session.sync(paths);
        if (paths === undefined) lastFullReconcile = Date.now();
        else if (
          lastFullReconcile > 0 &&
          Date.now() - lastFullReconcile >=
            (config.service?.reconcileSeconds ?? 600) * 1000
        )
          lastFullReconcile = Date.now();
        process.stdout.write(
          `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`,
        );
        if (result.status === "inconclusive" || result.status === "offline") {
          if (paths === undefined) fullReconcile = true;
          else for (const path of paths) dirtyPaths.add(path);
          await session[Symbol.asyncDispose]();
          session = null;
        }
        lastRun = Date.now();
      }
      await delay(Math.min(intervalMs, 250), undefined, {
        signal: controller.signal,
      }).catch(() => undefined);
    }
  } finally {
    watcher.close();
    if (session !== null) await session[Symbol.asyncDispose]();
    release();
  }
}

async function runHistory(commandArgs: readonly string[]): Promise<void> {
  const repository = positional(commandArgs, 0);
  printJson(await historyV2(load(commandArgs), repository));
}

async function runConflicts(commandArgs: readonly string[]): Promise<void> {
  const status = await statusV2(load(commandArgs));
  printJson(status.conflicts);
}

async function runRecover(commandArgs: readonly string[]): Promise<void> {
  const id = positional(commandArgs, 0);
  const destination = option(commandArgs, "--to");
  if (id === undefined || destination === undefined)
    throw new Error("Recover requires <manifest-id> --to <empty-path>");
  const config = load(commandArgs);
  const conflict = (await statusV2(config)).conflicts.find(
    (value) => value.conflictId === id,
  );
  const manifestId = conflict?.manifestId ?? id;
  if (manifestId === null)
    throw new Error("Conflict has no recoverable manifest");
  await recoverManifestV2(config, manifestId, destination);
  printJson({ recovered: true, manifestId, destination: resolve(destination) });
}

async function runResolveGit(commandArgs: readonly string[]): Promise<void> {
  const conflictId = positional(commandArgs, 0);
  const take = option(commandArgs, "--take");
  if (conflictId === undefined || (take !== "canonical" && take !== "conflict"))
    throw new Error(
      "Resolve Git requires <conflict-id> --take canonical or --take conflict",
    );
  const config = load(commandArgs);
  printJson(
    await withExclusiveWriter(config, () =>
      resolveGitConflictV2(config, conflictId, take),
    ),
  );
}

async function runVerify(commandArgs: readonly string[]): Promise<void> {
  if (!flag(commandArgs, "--full"))
    throw new Error("Verify currently requires --full");
  const config = load(commandArgs);
  const result = await withExclusiveWriter(config, () => verifyFullV2(config));
  printJson({ full: flag(commandArgs, "--full"), ...result });
  if (result.status === "offline" || result.status === "inconclusive")
    process.exitCode = 1;
}

function runService(commandArgs: readonly string[]): void {
  const action = positional(commandArgs, 0);
  if (action === undefined) throw new Error("Service action is required");
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const config = loadConfig(configPath);
  const explicitExecutable = option(commandArgs, "--executable");
  const explicitScript = option(commandArgs, "--script");
  const defaultCommand = defaultServiceCommand();
  const executablePath = resolve(
    explicitExecutable ?? defaultCommand.executablePath,
  );
  const definitionDirectory = option(commandArgs, "--definition-dir");
  const options = {
    configPath,
    executablePath,
    ...(explicitScript !== undefined
      ? { scriptPath: resolve(explicitScript) }
      : explicitExecutable === undefined &&
          defaultCommand.scriptPath !== undefined
        ? { scriptPath: defaultCommand.scriptPath }
        : {}),
    ...(definitionDirectory === undefined ? {} : { definitionDirectory }),
    activate: !flag(commandArgs, "--no-activate"),
  };
  switch (action) {
    case "install":
      printJson(installService(config, options));
      return;
    case "start":
      startService(config, options);
      break;
    case "stop":
      stopService(config);
      break;
    case "restart":
      restartService(config);
      break;
    case "status":
      printJson(serviceStatus(config, options));
      return;
    case "logs":
      printJson(serviceLogPaths(config));
      return;
    case "uninstall":
      printJson({ recoveredDefinition: uninstallService(config, options) });
      return;
    default:
      throw new Error(`Unknown service action: ${action}`);
  }
  printJson(serviceStatus(config, options));
}

async function runRepository(commandArgs: readonly string[]): Promise<void> {
  const action = positional(commandArgs, 0);
  const name = positional(commandArgs, 1);
  if (
    action !== "refresh" &&
    ((action !== "add" && action !== "remove") || name === undefined)
  )
    throw new Error(
      "Repository requires: repository <add|remove> <name> or repository refresh",
    );
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const config = loadConfig(configPath);
  const { updated, result } = await withExclusiveWriter(config, async () => {
    const updated =
      action === "refresh"
        ? await refreshRepositoryMembershipV2(config, configPath)
        : action === "add"
          ? await addRepositoryV2(config, configPath, name as string)
          : await removeRepositoryV2(config, configPath, name as string);
    return {
      updated,
      result: action === "remove" ? null : await syncFolderV2(updated),
    };
  });
  printJson({
    action,
    repository: name ?? null,
    repositories: updated.repositories.map((repository) => repository.name),
    synchronizedFilesDeleted: false,
    sync: result,
  });
}

async function runIgnore(commandArgs: readonly string[]): Promise<void> {
  const action = positional(commandArgs, 0);
  const config = load(commandArgs);
  if (action === "push") {
    printJson({
      action,
      patterns: await withExclusiveWriter(config, () =>
        pushIgnoreRulesV2(config),
      ),
    });
    return;
  }
  if (action === "pull") {
    printJson({
      action,
      patterns: await withExclusiveWriter(config, () =>
        pullIgnoreRulesV2(config),
      ),
    });
    return;
  }
  throw new Error("Ignore requires: ignore <push|pull>");
}

async function runHub(commandArgs: readonly string[]): Promise<void> {
  if (positional(commandArgs, 0) !== "serve" || !flag(commandArgs, "--stdio"))
    throw new Error(
      "Hub command requires: hub serve --stdio --hub-base64 <path>",
    );
  const encoded = option(commandArgs, "--hub-base64");
  if (encoded === undefined || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Hub path encoding is invalid");
  const hub = Buffer.from(encoded, "base64url").toString("utf8");
  if (!hub.startsWith("/")) throw new Error("Hub path must be absolute");
  await serveHubStdio(hub);
}

async function runGc(commandArgs: readonly string[]): Promise<void> {
  if (!flag(commandArgs, "--dry-run"))
    throw new Error("V2 garbage collection requires --dry-run");
  const config = load(commandArgs);
  await using transport = await import("./v2/transport.js").then(
    ({ HubTransport }) => HubTransport.connect(config.hub),
  );
  printJson({
    dryRun: true,
    ...(await transport.gcDryRun()),
    message:
      "Deletion remains disabled; this command reports reachability only",
  });
}

function runMigrationInventory(commandArgs: readonly string[]): void {
  if (!flag(commandArgs, "--dry-run"))
    throw new Error("V1 migration requires --dry-run for inventory");
  const root = option(commandArgs, "--root");
  if (root === undefined)
    throw new Error("Migration inventory requires --root");
  const absolute = resolve(root);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory())
    throw new Error("Migration root is not a directory");
  printJson({
    dryRun: true,
    root: absolute,
    entries: readDirectoryNames(absolute),
    mutation: false,
    next: "Create a fresh V2 hub and run setup after reviewing this inventory",
  });
}

function acquireDaemonLock(config: ProductConfig): () => void {
  const path = join(config.stateDir, "daemon.lock");
  try {
    const descriptor = openSync(path, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    closeSync(descriptor);
  } catch (error) {
    if (!existsSync(path)) throw error;
    const current = JSON.parse(readFileSync(path, "utf8")) as {
      readonly pid?: unknown;
    };
    if (typeof current.pid === "number" && processExists(current.pid))
      throw new Error(
        `CodeFolderSync daemon is already running with PID ${current.pid}`,
      );
    const recovery = join(
      config.stateDir,
      "recovery",
      `stale-daemon-lock-${Date.now()}`,
    );
    renameSync(path, recovery);
    return acquireDaemonLock(config);
  }
  return () => {
    if (existsSync(path)) unlinkSync(path);
  };
}

async function withExclusiveWriter<T>(
  config: ProductConfig,
  action: () => Promise<T>,
): Promise<T> {
  ensureLocalLayout(config);
  const release = acquireDaemonLock(config);
  try {
    return await action();
  } finally {
    release();
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultServiceCommand(): {
  readonly executablePath: string;
  readonly scriptPath?: string;
} {
  const stable = join(
    (process.getBuiltinModule("node:os") as typeof import("node:os")).homedir(),
    ".local",
    "bin",
    "codefoldersync",
  );
  if (existsSync(stable)) return { executablePath: stable };
  return {
    executablePath: process.execPath,
    scriptPath: resolve(process.argv[1] ?? "codefoldersync"),
  };
}

async function askForService(): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await prompt.question(
        "Install and start the user sync service? [yes/no] ",
      )
    )
      .trim()
      .toLowerCase();
    return answer === "yes" || answer === "y";
  } finally {
    prompt.close();
  }
}

function load(commandArgs: readonly string[]): ProductConfig {
  return loadConfig(
    resolve(option(commandArgs, "--config") ?? defaultConfigPath()),
  );
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function flag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function positional(
  args: readonly string[],
  index: number,
): string | undefined {
  const valueOptions = new Set([
    "--built",
    "--install-root",
    "--bin-dir",
    "--version",
    "--config",
    "--root",
    "--hub",
    "--mode",
    "--name",
    "--peer",
    "--folder-id",
    "--state",
    "--remote-command",
    "--remote-node",
    "--interval-ms",
    "--poll-ms",
    "--to",
    "--take",
    "--executable",
    "--script",
    "--definition-dir",
    "--hub-base64",
  ]);
  const values: string[] = [];
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const value = args[cursor];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      if (valueOptions.has(value)) cursor += 1;
      continue;
    }
    values.push(value);
  }
  return values[index];
}

function numberOption(
  args: readonly string[],
  name: string,
  fallback: number,
): number {
  const value = Number(option(args, name) ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readDirectoryNames(path: string): readonly string[] {
  return Object.keys(
    Object.fromEntries(
      // Reading names only keeps migration inventory content-free.
      requireDirectory(path).map((name) => [name, true]),
    ),
  ).sort();
}

function requireDirectory(path: string): string[] {
  // Kept separate to make the content-free migration boundary obvious.
  return (
    process.getBuiltinModule("node:fs") as typeof import("node:fs")
  ).readdirSync(path);
}

function printHelp(): void {
  process.stdout.write(`CodeFolderSync ${productVersion}

No account or signup. Peers use your existing SSH access.

Commands:
  codefoldersync install [--built <dist>] [--install-root <path>] [--bin-dir <path>]
  codefoldersync upgrade [--built <dist>]
  codefoldersync rollback --version <version>
  codefoldersync setup
  codefoldersync setup --mode <create|join> --root <path> --hub <path|ssh-url> [options]
  codefoldersync doctor [--config <path>]
  codefoldersync status [--config <path>]
  codefoldersync sync [--config <path>]
  codefoldersync daemon [--config <path>] [--interval-ms <milliseconds>]
  codefoldersync history [repository] [--config <path>]
  codefoldersync conflicts [--config <path>]
  codefoldersync recover <manifest-or-conflict-id> --to <empty-path>
  codefoldersync resolve-git <conflict-id> --take <canonical|conflict>
  codefoldersync verify --full [--config <path>]
  codefoldersync service <install|start|stop|restart|status|logs|uninstall>
  codefoldersync repository <add|remove> <name> [--config <path>]
  codefoldersync repository refresh [--config <path>]
  codefoldersync ignore <push|pull> [--config <path>]
  codefoldersync gc --dry-run [--config <path>]
  codefoldersync migrate-v1 --dry-run --root <path>
`);
}
