import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { normalizeRelativePath, verifyNoSymlinkEscape } from "./paths.js";
import {
  schemaVersion,
  type HubConfig,
  type ProductConfig,
  type RepositoryConfig,
} from "./types.js";

export function defaultConfigPath(): string {
  return join(
    homedir(),
    ".config",
    "codefoldersync",
    "folders",
    "default.json",
  );
}

export function defaultStateDir(root: string, folderId: string): string {
  return join(dirname(resolve(root)), `.codefoldersync-v2-${folderId}-state`);
}

export function parseHubSpec(
  value: string,
  command: readonly string[] = ["~/.local/bin/codefoldersync"],
): HubConfig {
  if (!value.startsWith("ssh://"))
    return { kind: "local", path: resolve(value) };
  const url = new URL(value);
  if (
    url.protocol !== "ssh:" ||
    url.hostname.length === 0 ||
    url.port.length > 0
  )
    throw new Error(
      "SSH hub must use ssh://user@host/absolute/path without a port",
    );
  const username = decodeURIComponent(url.username);
  const host =
    username.length === 0 ? url.hostname : `${username}@${url.hostname}`;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) throw new Error("SSH hub path must be absolute");
  if (!/^[A-Za-z0-9_.@:-]+$/u.test(host))
    throw new Error("SSH host is invalid");
  if (
    command.length === 0 ||
    command.some((part) => part.length === 0 || part.includes("\0"))
  )
    throw new Error("Remote command is invalid");
  return { kind: "ssh", host, path, command: [...command] };
}

export function discoverRepositories(
  root: string,
  allowEmpty: boolean,
  existing: ReadonlyMap<string, string> = new Map(),
): RepositoryConfig[] {
  const absolute = resolve(root);
  if (!existsSync(absolute))
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  verifyNoSymlinkEscape(absolute);
  const repositories: RepositoryConfig[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === ".codefoldersyncignore" && entry.isFile()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(
        `Folder root may contain only Git repositories: ${entry.name}`,
      );
    normalizeRelativePath(entry.name);
    const git = join(absolute, entry.name, ".git");
    if (!existsSync(git) || !lstatSync(git).isDirectory())
      throw new Error(
        `Repository requires an in-tree .git directory: ${entry.name}`,
      );
    repositories.push({
      name: entry.name,
      rootNodeId: existing.get(entry.name) ?? randomUUID(),
    });
  }
  repositories.sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (repositories.length === 0 && !allowEmpty)
    throw new Error("No direct-child Git repositories found");
  const aliases = new Set<string>();
  for (const repository of repositories) {
    const alias = repository.name.normalize("NFC").toLocaleLowerCase("en-US");
    if (aliases.has(alias))
      throw new Error(`Portable repository-name collision: ${repository.name}`);
    aliases.add(alias);
  }
  return repositories;
}

export function createConfig(input: {
  readonly folderId?: string;
  readonly folderName: string;
  readonly peerName: string;
  readonly root: string;
  readonly stateDir?: string;
  readonly repositories: readonly RepositoryConfig[];
  readonly hub: HubConfig;
}): ProductConfig {
  const folderId = input.folderId ?? randomUUID();
  const root = resolve(input.root);
  const config: ProductConfig = {
    schemaVersion,
    folderId,
    folderName: input.folderName,
    peerId: randomUUID(),
    peerName: input.peerName,
    root,
    stateDir: resolve(input.stateDir ?? defaultStateDir(root, folderId)),
    repositories: [...input.repositories],
    hub: input.hub,
    service: { intervalMs: 150, reconcileSeconds: 600 },
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: ProductConfig): void {
  if (config.schemaVersion !== schemaVersion)
    throw new Error("Unsupported config version");
  assertId(config.folderId, "Folder ID");
  assertId(config.peerId, "Peer ID");
  assertName(config.folderName, "Folder name");
  assertName(config.peerName, "Peer name");
  assertAbsolute(config.root, "Root");
  assertAbsolute(config.stateDir, "State directory");
  if (inside(config.root, config.stateDir))
    throw new Error("State directory must be outside the synchronized root");
  if (config.repositories.length === 0)
    throw new Error("At least one repository is required");
  const names = new Set<string>();
  const roots = new Set<string>();
  for (const repository of config.repositories) {
    normalizeRelativePath(repository.name);
    assertId(repository.rootNodeId, "Repository root node ID");
    const key = repository.name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(key))
      throw new Error(`Duplicate repository: ${repository.name}`);
    if (roots.has(repository.rootNodeId))
      throw new Error("Duplicate repository root ID");
    names.add(key);
    roots.add(repository.rootNodeId);
  }
  if (config.hub.kind === "local") {
    assertAbsolute(config.hub.path, "Hub path");
    if (inside(config.root, config.hub.path))
      throw new Error("Hub must be outside the synchronized root");
  }
}

export function ensureLocalLayout(config: ProductConfig): void {
  validateConfig(config);
  mkdirSync(config.root, { recursive: true, mode: 0o700 });
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const rootDevice = lstatSync(config.root).dev;
  const stateDevice = lstatSync(config.stateDir).dev;
  if (rootDevice !== stateDevice)
    throw new Error("Root and state directory must be on the same filesystem");
  for (const directory of ["objects", "staging", "recovery", "logs"]) {
    mkdirSync(join(config.stateDir, directory), {
      recursive: true,
      mode: 0o700,
    });
  }
}

export function saveConfig(path: string, config: ProductConfig): void {
  validateConfig(config);
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, absolute);
  chmodSync(absolute, 0o600);
}

export function loadConfig(path = defaultConfigPath()): ProductConfig {
  const input = record(
    JSON.parse(readFileSync(resolve(path), "utf8")) as unknown,
    "Config",
  );
  if (input.schemaVersion !== schemaVersion)
    throw new Error("Configuration is not CodeFolderSync V2");
  if (!Array.isArray(input.repositories))
    throw new Error("Repositories are invalid");
  const repositories = input.repositories.map((value, index) => {
    const repository = record(value, `Repository ${index}`);
    return {
      name: string(repository.name, "Repository name"),
      rootNodeId: string(repository.rootNodeId, "Repository root node ID"),
    };
  });
  const hubInput = record(input.hub, "Hub");
  let hub: HubConfig;
  if (hubInput.kind === "local") {
    hub = { kind: "local", path: string(hubInput.path, "Hub path") };
  } else if (hubInput.kind === "ssh") {
    if (!Array.isArray(hubInput.command))
      throw new Error("Hub command is invalid");
    hub = {
      kind: "ssh",
      host: string(hubInput.host, "Hub host"),
      path: string(hubInput.path, "Hub path"),
      command: hubInput.command.map((part) => string(part, "Hub command part")),
    };
  } else {
    throw new Error("Hub kind is invalid");
  }
  const serviceInput =
    input.service === undefined ? undefined : record(input.service, "Service");
  const config: ProductConfig = {
    schemaVersion,
    folderId: string(input.folderId, "Folder ID"),
    folderName: string(input.folderName, "Folder name"),
    peerId: string(input.peerId, "Peer ID"),
    peerName: string(input.peerName, "Peer name"),
    root: string(input.root, "Root"),
    stateDir: string(input.stateDir, "State directory"),
    repositories,
    hub,
    ...(serviceInput === undefined
      ? {}
      : {
          service: {
            intervalMs: positiveInteger(
              serviceInput.intervalMs,
              "Service interval",
            ),
            reconcileSeconds: positiveInteger(
              serviceInput.reconcileSeconds,
              "Reconcile seconds",
            ),
          },
        }),
  };
  validateConfig(config);
  return config;
}

export function readIgnorePatterns(root: string): readonly string[] {
  const path = join(root, ".codefoldersyncignore");
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isFile())
    throw new Error(".codefoldersyncignore must be a file");
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function inside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function assertAbsolute(value: string, label: string): void {
  if (resolve(value) !== value) throw new Error(`${label} must be absolute`);
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value))
    throw new Error(`${label} is invalid`);
}

function assertName(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 160 || value.includes("\0"))
    throw new Error(`${label} is invalid`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
  return value;
}
