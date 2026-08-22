#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  activateInstalledVersion,
  installSelf,
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
  defaultConfigPath,
  loadConfig,
  parseHubSpec,
  type PeerEnrollmentRequest,
} from "./v3/config.js";
import {
  applyAdoptionV3,
  acceptIgnoreRevisionV3,
  cutoverAdoptionV3,
  hasRemoteChangesV3,
  historyV3,
  planAdoptionV3,
  previewIgnoreRevisionV3,
  promoteConflictV3,
  recoverConflictV3,
  sealSourceV3,
  statusV3,
  syncFolderV3,
  verifyFullV3,
} from "./v3/engine.js";
import { ObjectStore } from "./v3/objects.js";
import {
  interactiveFleetSetupV3,
  readFleetSetupSpec,
  setupPopulatedFleetV3,
} from "./v3/orchestrator.js";
import {
  activatePeerV3,
  enrollPeerV3,
  preparePeerEnrollment,
  readEnrollmentRequest,
  setupAuthorityV3,
} from "./v3/setup.js";
import { LocalState } from "./v3/state.js";
import { serveHubStdio } from "./v3/transport.js";
import {
  protocolVersion,
  schemaVersion,
  type ProductConfig,
} from "./v3/types.js";

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
    case "version":
    case "--version":
      process.stdout.write(`codefoldersync ${productVersion}\n`);
      return;
    case "install":
    case "upgrade":
      runInstall(args);
      return;
    case "rollback":
      runRollback(args);
      return;
    case "setup":
      await runSetup(args);
      return;
    case "adoption":
      await runAdoption(args);
      return;
    case "sync":
      await runSync(args);
      return;
    case "verify":
      await runVerify(args);
      return;
    case "status":
    case "doctor":
      await runStatus(args, command === "doctor");
      return;
    case "config":
      await runConfig(args);
      return;
    case "catalog":
      runCatalog(args);
      return;
    case "history":
      printJson(await historyV3(load(args)));
      return;
    case "conflicts":
      printJson((await statusV3(load(args))).conflicts);
      return;
    case "recover":
    case "promote-conflict":
      await runRecover(args, command === "promote-conflict");
      return;
    case "daemon":
      await runDaemon(args);
      return;
    case "service":
      runService(args);
      return;
    case "hub":
      await runHub(args);
      return;
    case "gc":
      runGc(args);
      return;
    default:
      throw new Error(`Unknown V3 command: ${command}`);
  }
}

function runInstall(commandArgs: readonly string[]): void {
  const built = resolve(
    option(commandArgs, "--built") ?? dirname(fileURLToPath(import.meta.url)),
  );
  const installRoot = option(commandArgs, "--install-root");
  const binaryDirectory = option(commandArgs, "--bin-dir");
  printJson({
    installed: true,
    version: productVersion,
    ...installSelf({
      builtDirectory: built,
      ...(installRoot === undefined ? {} : { installRoot }),
      ...(binaryDirectory === undefined ? {} : { binaryDirectory }),
    }),
  });
}

function runRollback(commandArgs: readonly string[]): void {
  const version = option(commandArgs, "--version");
  if (version === undefined) throw new Error("Rollback requires --version");
  const installRoot = option(commandArgs, "--install-root");
  const binaryDirectory = option(commandArgs, "--bin-dir");
  printJson({
    activated: version,
    available: installedVersions(installRoot),
    ...activateInstalledVersion({
      version,
      ...(installRoot === undefined ? {} : { installRoot }),
      ...(binaryDirectory === undefined ? {} : { binaryDirectory }),
    }),
  });
}

async function runSetup(commandArgs: readonly string[]): Promise<void> {
  const mode = option(commandArgs, "--mode");
  if (mode === undefined) {
    const result = await interactiveFleetSetupV3();
    printJson({
      configured: true,
      folderId: result.authority.folderId,
      lifecycle: result.lifecycle,
      sourceSeal: result.sourceSeal,
      targets: result.targets.map(
        ({ config, adoptionId, result: adoption }) => ({
          peerId: config.peerId,
          peerName: config.peerName,
          adoptionId,
          adoption,
        }),
      ),
      cutoverReady: result.cutoverReady,
      servicesEnabled: result.servicesEnabled,
    });
    return;
  }
  if (mode === "authority") {
    const root = requiredOption(commandArgs, "--root");
    const hub = requiredOption(commandArgs, "--hub");
    const backupWitness = requiredOption(commandArgs, "--backup-witness");
    const stateDir = option(commandArgs, "--state");
    const configPath = option(commandArgs, "--config");
    const result = await setupAuthorityV3({
      root,
      folderName: option(commandArgs, "--name") ?? "code",
      peerName: option(commandArgs, "--peer") ?? hostname(),
      hub: parseHubSpec(hub, remoteCommand(commandArgs)),
      backupWitness,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(configPath === undefined ? {} : { configPath }),
    });
    printJson({
      configured: true,
      folderId: result.config.folderId,
      peerId: result.config.peerId,
      lifecycle: result.config.lifecycle,
      configRevision: result.config.revision,
      filesystem: result.filesystem,
      serviceActivation: "disabled",
    });
    return;
  }
  if (mode === "fleet") {
    if (!flag(commandArgs, "--approve"))
      throw new Error("Populated fleet setup requires explicit --approve");
    const result = await setupPopulatedFleetV3(
      readFleetSetupSpec(requiredOption(commandArgs, "--spec")),
    );
    printJson({
      configured: true,
      folderId: result.authority.folderId,
      lifecycle: result.lifecycle,
      sourceSeal: result.sourceSeal,
      targets: result.targets.map(
        ({ config, adoptionId, result: adoption }) => ({
          peerId: config.peerId,
          peerName: config.peerName,
          adoptionId,
          adoption,
        }),
      ),
      cutoverReady: result.cutoverReady,
      servicesEnabled: result.servicesEnabled,
    });
    return;
  }
  if (mode === "request") {
    const accepted = loadConfig(
      requiredOption(commandArgs, "--accepted-config"),
    );
    const requestPath = resolve(requiredOption(commandArgs, "--request"));
    const request = preparePeerEnrollment({
      acceptedConfig: accepted,
      root: requiredOption(commandArgs, "--root"),
      stateDir: requiredOption(commandArgs, "--state"),
      peerName: option(commandArgs, "--peer") ?? hostname(),
      ...(flag(commandArgs, "--hub-role") ? { role: "hub" as const } : {}),
      requestPath,
    });
    printJson({
      requestPath,
      peer: request.peer,
      secretMaterialExported: false,
    });
    return;
  }
  if (mode === "enroll") {
    const configPath = resolve(
      option(commandArgs, "--config") ?? defaultConfigPath(),
    );
    const authorityConfig = loadConfig(configPath);
    const updated = await enrollPeerV3({
      authorityConfig,
      authorityConfigPath: configPath,
      request: readEnrollmentRequest(requiredOption(commandArgs, "--request")),
    });
    printJson({
      enrolled: true,
      configRevision: updated.revision,
      peers: updated.peers.map(({ peerId, peerName, role, root }) => ({
        peerId,
        peerName,
        role,
        root,
      })),
    });
    return;
  }
  if (mode === "activate") {
    const accepted = loadConfig(
      requiredOption(commandArgs, "--accepted-config"),
    );
    const request = readEnrollmentRequest(
      requiredOption(commandArgs, "--request"),
    );
    const ignorePath = option(commandArgs, "--ignore");
    const configPath = option(commandArgs, "--config");
    const config = activatePeerV3({
      acceptedConfig: accepted,
      request,
      stateDir: requiredOption(commandArgs, "--state"),
      ...(configPath === undefined ? {} : { configPath }),
      ...(ignorePath === undefined
        ? {}
        : { ignoreSource: readFileSync(resolve(ignorePath), "utf8") }),
    });
    printJson({
      configured: true,
      folderId: config.folderId,
      peerId: config.peerId,
      lifecycle: config.lifecycle,
      configRevision: config.revision,
      serviceActivation: "disabled",
    });
    return;
  }
  throw new Error(
    "Setup mode must be fleet, authority, request, enroll, or activate",
  );
}

async function runAdoption(commandArgs: readonly string[]): Promise<void> {
  const action = positional(commandArgs, 0);
  const config = load(commandArgs);
  switch (action) {
    case "seal":
      printJson(await withExclusiveWriter(config, () => sealSourceV3(config)));
      return;
    case "plan":
      printJson(await planAdoptionV3(config));
      return;
    case "apply": {
      const adoptionId = option(commandArgs, "--adoption-id");
      if (adoptionId === undefined)
        throw new Error(
          "Adoption apply requires --adoption-id from adoption plan",
        );
      printJson(
        await withExclusiveWriter(config, () =>
          applyAdoptionV3(config, adoptionId),
        ),
      );
      return;
    }
    case "verify":
      printJson(await withExclusiveWriter(config, () => verifyFullV3(config)));
      return;
    case "cutover": {
      if (!flag(commandArgs, "--approve"))
        throw new Error("Adoption cutover requires explicit --approve");
      const configPath = resolve(
        option(commandArgs, "--config") ?? defaultConfigPath(config.root),
      );
      const updated = await withExclusiveWriter(config, () =>
        cutoverAdoptionV3(config, configPath),
      );
      printJson({
        cutover: true,
        lifecycle: updated.lifecycle,
        configRevision: updated.revision,
        servicesEnabled: false,
        next: "Project the accepted revision to every peer, then start services one at a time",
      });
      return;
    }
    default:
      throw new Error(
        "Adoption requires seal, plan, apply, verify, or cutover",
      );
  }
}

async function runSync(commandArgs: readonly string[]): Promise<void> {
  const config = load(commandArgs);
  const result = await withExclusiveWriter(config, () => syncFolderV3(config));
  printJson(result);
  if (result.status === "offline" || result.status === "inconclusive")
    process.exitCode = 1;
}

async function runVerify(commandArgs: readonly string[]): Promise<void> {
  if (!flag(commandArgs, "--full"))
    throw new Error("V3 verification requires --full");
  const config = load(commandArgs);
  const result = await withExclusiveWriter(config, () => verifyFullV3(config));
  printJson({ full: true, ...result });
  if (result.status !== "clean" && result.status !== "conflict")
    process.exitCode = 1;
}

async function runStatus(
  commandArgs: readonly string[],
  doctor: boolean,
): Promise<void> {
  const config = load(commandArgs);
  const status = await statusV3(config);
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(config.root),
  );
  const serviceCommand = defaultServiceCommand();
  const definitionDirectory = option(commandArgs, "--definition-dir");
  printJson({
    ...(doctor
      ? {
          ready: true,
          version: productVersion,
          schemaVersion,
          protocolVersion,
          root: config.root,
          stateDir: config.stateDir,
          peerId: config.peerId,
          authorityPeerId: config.authority.peerId,
        }
      : {}),
    ...status,
    service: serviceStatus(config, {
      configPath,
      executablePath: serviceCommand.executablePath,
      ...(serviceCommand.scriptPath === undefined
        ? {}
        : { scriptPath: serviceCommand.scriptPath }),
      ...(definitionDirectory === undefined ? {} : { definitionDirectory }),
      activate: false,
    }),
  });
}

async function runConfig(commandArgs: readonly string[]): Promise<void> {
  const action = positional(commandArgs, 0);
  const config = load(commandArgs);
  if (action === "update-ignore") {
    const previousPath = requiredOption(commandArgs, "--previous-ignore");
    const previous = readFileSync(resolve(previousPath), "utf8");
    const preview = await previewIgnoreRevisionV3(config, previous);
    if (!flag(commandArgs, "--approve")) {
      printJson({ approved: false, mutation: false, ...preview });
      return;
    }
    const configPath = resolve(
      option(commandArgs, "--config") ?? defaultConfigPath(config.root),
    );
    const updated = await withExclusiveWriter(config, () =>
      acceptIgnoreRevisionV3(config, configPath, previous),
    );
    printJson({
      approved: true,
      configRevision: updated.revision,
      ignoreDigest: updated.ignoreDigest,
      ...preview,
    });
    return;
  }
  if (action !== "status")
    throw new Error("Config supports status or update-ignore");
  const status = await statusV3(config);
  printJson({
    folderId: config.folderId,
    peerId: config.peerId,
    authorityPeerId: config.authority.peerId,
    revision: config.revision,
    lifecycle: config.lifecycle,
    ignoreDigest: config.ignoreDigest,
    acceptedHubRevision: status.acceptedConfigRevision,
    hubReachable: status.hubReachable,
    hubError: status.hubError,
  });
}

function runCatalog(commandArgs: readonly string[]): void {
  if (positional(commandArgs, 0) !== "status")
    throw new Error(
      "Catalog is derived and supports observation only: catalog status",
    );
  const config = load(commandArgs);
  using state = new LocalState(config);
  const entries = state.catalog();
  const history = state.catalogHistory();
  printJson({
    derived: true,
    mutationCommands: false,
    entries: entries.length,
    directories: entries.filter((entry) => entry.kind === "directory").length,
    files: entries.filter((entry) => entry.kind === "regular").length,
    symlinks: entries.filter((entry) => entry.kind === "symlink").length,
    acceptedHistory: history.length,
    retainedTombstones: history.filter((entry) => entry.tombstone).length,
  });
}

async function runRecover(
  commandArgs: readonly string[],
  promote: boolean,
): Promise<void> {
  const conflictId = positional(commandArgs, 0);
  const destination = option(commandArgs, "--to");
  if (conflictId === undefined || (!promote && destination === undefined))
    throw new Error("Recover requires <conflict-id> --to <absent-path>");
  const config = load(commandArgs);
  if (promote) {
    const promotedPath = await withExclusiveWriter(config, async () =>
      promoteConflictV3(config, conflictId, destination),
    );
    printJson({ promoted: true, conflictId, path: promotedPath });
    return;
  }
  recoverConflictV3(config, conflictId, destination ?? "");
  printJson({
    recovered: true,
    conflictId,
    destination: resolve(destination ?? ""),
  });
}

async function runDaemon(commandArgs: readonly string[]): Promise<void> {
  const config = load(commandArgs);
  if (config.lifecycle !== "normal")
    throw new Error("Daemon remains disabled until adoption cutover");
  const release = acquireDaemonLock(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  let dirty = true;
  let lastReconcile = 0;
  const watcher = watch(config.root, { recursive: true }, () => {
    dirty = true;
  });
  watcher.on("error", (error) => {
    process.stderr.write(`watcher degraded: ${error.message}\n`);
    dirty = true;
  });
  const interval = numberOption(
    commandArgs,
    "--interval-ms",
    config.service?.intervalMs ?? 150,
  );
  try {
    while (!controller.signal.aborted) {
      if (
        !dirty &&
        Date.now() - lastReconcile >=
          (config.service?.reconcileSeconds ?? 600) * 1000
      )
        dirty = true;
      if (!dirty) {
        try {
          dirty = await hasRemoteChangesV3(config);
        } catch (error) {
          process.stderr.write(
            `hub offline: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (dirty) {
        await delay(interval, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
        const result = await syncFolderV3(config);
        process.stdout.write(
          `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`,
        );
        dirty = result.status === "offline" || result.status === "inconclusive";
        if (!dirty) lastReconcile = Date.now();
      }
      await delay(Math.min(interval, 250), undefined, {
        signal: controller.signal,
      }).catch(() => undefined);
    }
  } finally {
    watcher.close();
    release();
  }
}

function runService(commandArgs: readonly string[]): void {
  const action = positional(commandArgs, 0);
  if (action === undefined) throw new Error("Service action is required");
  const configPath = resolve(
    option(commandArgs, "--config") ?? defaultConfigPath(),
  );
  const config = loadConfig(configPath);
  const defaults = defaultServiceCommand();
  const definitionDirectory = option(commandArgs, "--definition-dir");
  const options = {
    configPath,
    executablePath: resolve(
      option(commandArgs, "--executable") ?? defaults.executablePath,
    ),
    ...(option(commandArgs, "--script") === undefined
      ? defaults.scriptPath === undefined
        ? {}
        : { scriptPath: defaults.scriptPath }
      : { scriptPath: resolve(option(commandArgs, "--script") as string) }),
    ...(definitionDirectory === undefined ? {} : { definitionDirectory }),
    activate: action !== "install" || flag(commandArgs, "--activate"),
  };
  switch (action) {
    case "install":
      if (options.activate && config.lifecycle !== "normal")
        throw new Error("Service cannot activate before adoption cutover");
      printJson({
        ...installService(config, options),
        activation: options.activate,
      });
      return;
    case "start":
      if (config.lifecycle !== "normal")
        throw new Error("Service cannot start before adoption cutover");
      startService(config, options);
      break;
    case "stop":
      stopService(config);
      break;
    case "restart":
      if (config.lifecycle !== "normal")
        throw new Error("Service cannot restart before adoption cutover");
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

async function runHub(commandArgs: readonly string[]): Promise<void> {
  if (positional(commandArgs, 0) !== "serve" || !flag(commandArgs, "--stdio"))
    throw new Error("Hub requires hub serve --stdio --hub-base64 <path>");
  const encoded = requiredOption(commandArgs, "--hub-base64");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Hub path encoding is invalid");
  const path = Buffer.from(encoded, "base64url").toString("utf8");
  if (!path.startsWith("/")) throw new Error("Hub path must be absolute");
  await serveHubStdio(path);
}

function runGc(commandArgs: readonly string[]): void {
  if (!flag(commandArgs, "--dry-run"))
    throw new Error(
      "V3 garbage collection is report-only and requires --dry-run",
    );
  const config = load(commandArgs);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  printJson({
    dryRun: true,
    automaticDeletion: false,
    retainedLocalObjects: objects.listIds().length,
    message: "V3 retains objects, events, conflicts, and recovery by default",
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
      "apply-recovery",
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

function load(commandArgs: readonly string[]): ProductConfig {
  return loadConfig(
    resolve(option(commandArgs, "--config") ?? defaultConfigPath()),
  );
}

function remoteCommand(commandArgs: readonly string[]): readonly string[] {
  const command =
    option(commandArgs, "--remote-command") ?? "~/.local/bin/codefoldersync";
  const node = option(commandArgs, "--remote-node");
  return node === undefined ? [command] : [node, command];
}

function defaultServiceCommand(): {
  readonly executablePath: string;
  readonly scriptPath?: string;
} {
  const current = fileURLToPath(import.meta.url);
  return current.endsWith(".ts")
    ? { executablePath: process.execPath, scriptPath: current }
    : { executablePath: process.execPath, scriptPath: current };
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function flag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function positional(
  args: readonly string[],
  index: number,
): string | undefined {
  const valueOptions = new Set([
    "--config",
    "--root",
    "--state",
    "--hub",
    "--mode",
    "--name",
    "--peer",
    "--backup-witness",
    "--accepted-config",
    "--request",
    "--ignore",
    "--adoption-id",
    "--to",
    "--built",
    "--install-root",
    "--bin-dir",
    "--version",
    "--remote-command",
    "--remote-node",
    "--interval-ms",
    "--definition-dir",
    "--executable",
    "--script",
    "--hub-base64",
    "--previous-ignore",
    "--spec",
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

function printHelp(): void {
  process.stdout.write(`CodeFolderSync ${productVersion}

Recursive Code-folder synchronization with source-authoritative adoption.

Commands:
  codefoldersync setup
  codefoldersync setup --mode fleet --spec <path> --approve
  codefoldersync setup --mode authority --root <path> --hub <path|ssh-url> --backup-witness <id>
  codefoldersync setup --mode request --accepted-config <path> --root <path> --state <path> --request <path>
  codefoldersync setup --mode enroll --config <authority-config> --request <path>
  codefoldersync setup --mode activate --accepted-config <path> --state <path> --request <path>
  codefoldersync adoption <seal|plan|verify> [--config <path>]
  codefoldersync adoption apply --adoption-id <id> [--config <path>]
  codefoldersync adoption cutover --approve [--config <path>]
  codefoldersync sync|status|doctor|conflicts|history [--config <path>]
  codefoldersync verify --full [--config <path>]
  codefoldersync config status [--config <path>]
  codefoldersync config update-ignore --previous-ignore <path> [--approve]
  codefoldersync catalog status [--config <path>]
  codefoldersync recover <conflict-id> --to <absent-path>
  codefoldersync promote-conflict <conflict-id> [--to <relative-absent-path>]
  codefoldersync service <install|start|stop|restart|status|logs|uninstall>
  codefoldersync gc --dry-run [--config <path>]
`);
}
