import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./io.js";
import {
  productSchemaVersion,
  type HubConfig,
  type ProductConfig,
} from "./types.js";
import {
  assertAbsolutePath,
  assertId,
  assertPeerName,
  assertRemoteCommand,
  assertSshHost,
  assertUnit,
  normalizedCollisionKey,
  pathIsInside,
} from "./validation.js";

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "codefoldersync", "config.json");
}

export function defaultStateDir(root: string, folderId: string): string {
  return join(dirname(root), `.codefoldersync-${folderId}-state`);
}

export function loadProductConfig(path: string): ProductConfig {
  const value = record(readJson(resolve(path)), "Configuration");
  if (value.schemaVersion !== productSchemaVersion) {
    throw new Error("Unsupported CodeFolderSync configuration version");
  }
  const unitsRaw = value.units;
  if (!Array.isArray(unitsRaw) || unitsRaw.length === 0) {
    throw new Error("Configuration units must be a non-empty array");
  }
  const units = unitsRaw.map((unit, index) => string(unit, `Unit ${index}`));
  const config: ProductConfig = {
    schemaVersion: productSchemaVersion,
    folderId: string(value.folderId, "Folder ID"),
    folderName: string(value.folderName, "Folder name"),
    peerId: string(value.peerId, "Peer ID"),
    peerName: string(value.peerName, "Peer name"),
    root: string(value.root, "Root"),
    stateDir: string(value.stateDir, "State directory"),
    units,
    hub: parseHub(value.hub),
  };
  validateProductConfig(config);
  return config;
}

export function saveProductConfig(path: string, config: ProductConfig): void {
  validateProductConfig(config);
  writeJsonAtomic(resolve(path), config);
  chmodSync(resolve(path), 0o600);
}

export function createProductConfig(input: {
  readonly folderId?: string;
  readonly folderName: string;
  readonly peerName: string;
  readonly root: string;
  readonly stateDir?: string;
  readonly units: readonly string[];
  readonly hub: HubConfig;
}): ProductConfig {
  const root = resolve(input.root);
  const folderId = input.folderId ?? randomUUID();
  const config: ProductConfig = {
    schemaVersion: productSchemaVersion,
    folderId,
    folderName: input.folderName,
    peerId: randomUUID(),
    peerName: input.peerName,
    root,
    stateDir: resolve(input.stateDir ?? defaultStateDir(root, folderId)),
    units: [...input.units].sort(),
    hub: input.hub,
  };
  validateProductConfig(config);
  return config;
}

export function validateProductConfig(config: ProductConfig): void {
  assertId(config.folderId, "Folder ID");
  assertId(config.peerId, "Peer ID");
  assertPeerName(config.peerName);
  if (config.folderName.trim().length === 0 || config.folderName.length > 160) {
    throw new Error("Folder name is invalid");
  }
  assertAbsolutePath(config.root, "Root");
  assertAbsolutePath(config.stateDir, "State directory");
  if (
    config.stateDir === config.root ||
    pathIsInside(config.root, config.stateDir)
  ) {
    throw new Error("State directory must be outside the synchronized root");
  }
  if (config.units.length === 0)
    throw new Error("At least one repository is required");
  const collisions = new Set<string>();
  for (const unit of config.units) {
    assertUnit(unit);
    const key = normalizedCollisionKey(unit);
    if (collisions.has(key))
      throw new Error(`Repository name collision: ${unit}`);
    collisions.add(key);
  }
  if (config.hub.kind === "local") {
    assertAbsolutePath(config.hub.path, "Hub path");
    if (
      config.hub.path === config.root ||
      pathIsInside(config.root, config.hub.path)
    ) {
      throw new Error("Local hub must be outside the synchronized root");
    }
  } else {
    assertSshHost(config.hub.host);
    assertAbsolutePath(config.hub.path, "Hub path");
    if (config.hub.command.length === 0)
      throw new Error("Remote command is empty");
    for (const part of config.hub.command) assertRemoteCommand(part);
  }
}

export function discoverRepositoryUnits(
  root: string,
  allowEmpty: boolean,
): string[] {
  const absolute = resolve(root);
  if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
  const entries = readdirSync(absolute, { withFileTypes: true });
  if (entries.length === 0 && allowEmpty) return [];
  const units: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !existsSync(join(absolute, entry.name, ".git"))
    ) {
      throw new Error(
        `V1 root may contain only direct-child Git repositories: ${entry.name}`,
      );
    }
    units.push(entry.name);
  }
  if (units.length === 0)
    throw new Error("No direct-child Git repositories found");
  const collisions = new Set<string>();
  for (const unit of units) {
    assertUnit(unit);
    const key = normalizedCollisionKey(unit);
    if (collisions.has(key))
      throw new Error(`Repository name collision: ${unit}`);
    collisions.add(key);
  }
  return units.sort();
}

export function ensureLocalLayout(config: ProductConfig): void {
  mkdirSync(config.root, { recursive: true });
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const rootDevice = statSync(config.root).dev;
  const stateDevice = statSync(config.stateDir).dev;
  if (rootDevice !== stateDevice) {
    throw new Error("Root and state directory must be on the same filesystem");
  }
}

function parseHub(input: unknown): HubConfig {
  const value = record(input, "Hub");
  if (value.kind === "local") {
    return { kind: "local", path: string(value.path, "Hub path") };
  }
  if (value.kind === "ssh") {
    return {
      kind: "ssh",
      host: string(value.host, "SSH host"),
      path: string(value.path, "Hub path"),
      command: stringArray(value.command, "Remote command"),
    };
  }
  throw new Error("Hub kind must be local or ssh");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((part, index) => string(part, `${label} part ${index}`));
}
