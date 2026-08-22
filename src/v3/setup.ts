import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { canonicalJson } from "../v2/hash.js";
import {
  activatePeerProjection,
  authorityPrivateKey,
  createAuthorityConfig,
  createPeerEnrollmentRequest,
  defaultConfigPath,
  enrollPeer,
  ensureIgnore,
  loadConfig,
  parseHubSpec,
  projectConfigForPeer,
  saveConfig,
  type PeerEnrollmentRequest,
} from "./config.js";
import { defaultIgnore } from "./ignore.js";
import { HubTransport } from "./transport.js";
import { LocalState } from "./state.js";
import type { HubConfig, ProductConfig } from "./types.js";

export type AuthoritySetupFaultPoint =
  "after-authority-projection" | "after-folder-creation";

export interface AuthoritySetupOptions {
  readonly fault?: (point: AuthoritySetupFaultPoint) => void;
}

export type EnrollmentFaultPoint =
  | "after-peer-role-journal"
  | "after-peer-role-accept"
  | "after-authority-projection";

export interface EnrollmentOptions {
  readonly fault?: (point: EnrollmentFaultPoint) => void;
}

export type ProjectionFaultPoint =
  | "after-projection-journal"
  | "after-ignore-projection"
  | "after-config-projection";

export interface ProjectionOptions {
  readonly fault?: (point: ProjectionFaultPoint) => void;
}

export interface AuthoritySetupInput {
  readonly root: string;
  readonly stateDir?: string;
  readonly folderName: string;
  readonly peerName: string;
  readonly configPath?: string;
  readonly hub: HubConfig;
  readonly backupWitness?: string;
}

export async function setupAuthorityV3(
  input: AuthoritySetupInput,
  options: AuthoritySetupOptions = {},
): Promise<{
  readonly config: ProductConfig;
  readonly filesystem: ReturnType<typeof probeFilesystem>;
}> {
  const root = resolve(input.root);
  if (
    input.hub.kind === "local" &&
    (resolve(input.hub.path) === root ||
      resolve(input.hub.path).startsWith(`${root}${sep}`))
  )
    throw new Error("Hub must be outside the synchronized root");
  const configPath = resolve(input.configPath ?? defaultConfigPath(root));
  const config = existsSync(configPath)
    ? loadConfig(configPath)
    : createAuthorityConfig(input);
  if (
    config.root !== root ||
    config.stateDir !== resolve(input.stateDir ?? config.stateDir) ||
    config.folderName !== input.folderName ||
    config.peerName !== input.peerName ||
    canonicalJson(config.hub) !== canonicalJson(input.hub) ||
    config.backupWitness !== (input.backupWitness ?? null)
  )
    throw new Error("Existing authority setup does not match this request");
  const filesystem = probeFilesystem(config.root, config.stateDir);
  using state = new LocalState(config);
  const journalId = `authority-setup:${config.folderId}`;
  const journalValue = { configPath, folderId: config.folderId };
  const journal = state.journals().find((value) => value.id === journalId);
  if (
    journal !== undefined &&
    canonicalJson(journal.value) !== canonicalJson(journalValue)
  )
    throw new Error("Authority setup journal does not match this request");
  if (journal === undefined)
    state.putJournal(journalId, "authority-setup", journalValue);
  saveConfig(configPath, config, false);
  options.fault?.("after-authority-projection");
  await using transport = await HubTransport.connect(config.hub);
  try {
    const checkpoint = await transport.checkpoint(config.folderId);
    if (canonicalJson(checkpoint.config) !== canonicalJson(config))
      throw new Error("Existing hub folder differs from authority setup");
  } catch (error) {
    if (!String(error).includes("Unknown folder")) throw error;
    await transport.createFolder(config);
  }
  options.fault?.("after-folder-creation");
  state.completeJournal(journalId);
  return { config, filesystem };
}

export async function enrollPeerV3(
  input: {
    readonly authorityConfig: ProductConfig;
    readonly authorityConfigPath: string;
    readonly request: PeerEnrollmentRequest;
  },
  options: EnrollmentOptions = {},
): Promise<ProductConfig> {
  const updated = enrollPeer(
    input.authorityConfig,
    input.request,
    authorityPrivateKey(input.authorityConfig),
  );
  using state = new LocalState(input.authorityConfig);
  const journalId = `peer-role:${updated.revision}`;
  const journalValue = {
    configPath: resolve(input.authorityConfigPath),
    expectedRevision: input.authorityConfig.revision,
    updated,
  };
  const journal = state.journals().find((value) => value.id === journalId);
  if (
    journal !== undefined &&
    canonicalJson(journal.value) !== canonicalJson(journalValue)
  )
    throw new Error("Peer-role journal does not match this enrollment");
  if (journal === undefined) {
    state.putJournal(journalId, "peer-role", journalValue);
    options.fault?.("after-peer-role-journal");
  }
  await using transport = await HubTransport.connect(updated.hub);
  const checkpoint = await transport.checkpoint(updated.folderId);
  if (canonicalJson(checkpoint.config) !== canonicalJson(updated))
    await transport.updateConfig(updated, input.authorityConfig.revision);
  options.fault?.("after-peer-role-accept");
  saveConfig(input.authorityConfigPath, updated, false);
  options.fault?.("after-authority-projection");
  state.completeJournal(journalId);
  return updated;
}

export function preparePeerEnrollment(input: {
  readonly acceptedConfig: ProductConfig;
  readonly root: string;
  readonly stateDir: string;
  readonly peerName: string;
  readonly role?: "peer" | "hub";
  readonly requestPath: string;
}): PeerEnrollmentRequest {
  const request = createPeerEnrollmentRequest({
    folderId: input.acceptedConfig.folderId,
    root: input.root,
    stateDir: input.stateDir,
    peerName: input.peerName,
    ...(input.role === undefined ? {} : { role: input.role }),
  });
  writeFileSync(input.requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return request;
}

export function activatePeerV3(
  input: {
    readonly acceptedConfig: ProductConfig;
    readonly request: PeerEnrollmentRequest;
    readonly stateDir: string;
    readonly configPath?: string;
    readonly ignoreSource?: string;
  },
  options: ProjectionOptions = {},
): ProductConfig {
  const config = activatePeerProjection(
    input.acceptedConfig,
    input.request,
    input.stateDir,
  );
  const ignorePath = join(config.root, ".codefoldersyncignore");
  const configPath = resolve(
    input.configPath ?? defaultConfigPath(config.root),
  );
  const source = input.ignoreSource ?? defaultIgnore;
  using state = new LocalState(config);
  const journalId = `config-projection:${config.revision}`;
  const journalValue = {
    configPath,
    ignorePath,
    ignoreDigest: config.ignoreDigest,
    revision: config.revision,
  };
  const journal = state.journals().find((value) => value.id === journalId);
  if (
    journal !== undefined &&
    canonicalJson(journal.value) !== canonicalJson(journalValue)
  )
    throw new Error("Configuration projection journal does not match");
  if (journal === undefined) {
    state.putJournal(journalId, "config-projection", journalValue);
    options.fault?.("after-projection-journal");
  }
  if (!existsSync(ignorePath) || readFileSync(ignorePath, "utf8") !== source) {
    const temporary = `${ignorePath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, source, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, ignorePath);
  }
  options.fault?.("after-ignore-projection");
  if (ensureIgnore(config.root).digest !== config.ignoreDigest)
    throw new Error("Target ignore projection differs from authority");
  probeFilesystem(config.root, config.stateDir);
  saveConfig(configPath, config, true);
  options.fault?.("after-config-projection");
  state.completeJournal(journalId);
  return config;
}

export async function interactiveSetupV3(): Promise<{
  readonly config: ProductConfig;
  readonly filesystem: ReturnType<typeof probeFilesystem>;
}> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Interactive setup requires a terminal; use flags for automation",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const root = (await prompt.question("Code folder path: ")).trim();
    const hub = (
      await prompt.question("Hub path or ssh://user@host/absolute/path: ")
    ).trim();
    const peerName =
      (await prompt.question(`Authority machine [${hostname()}]: `)).trim() ||
      hostname();
    const backupWitness = (
      await prompt.question("Verified encrypted backup witness ID: ")
    ).trim();
    if (!backupWitness)
      throw new Error("Setup requires a verified backup witness ID");
    const confirmed = (
      await prompt.question(
        `Create a disabled V3 adoption configuration for ${resolve(root)}? [yes/no] `,
      )
    )
      .trim()
      .toLowerCase();
    if (confirmed !== "yes" && confirmed !== "y")
      throw new Error("Setup cancelled");
    return setupAuthorityV3({
      root,
      folderName: "code",
      peerName,
      hub: parseHubSpec(hub),
      backupWitness,
    });
  } finally {
    prompt.close();
  }
}

function probeFilesystem(
  root: string,
  stateDir: string,
): {
  readonly atomicRename: true;
  readonly symlink: true;
  readonly caseSensitive: boolean;
  readonly unicodeDistinct: boolean;
  readonly sameFilesystem: true;
} {
  const directory = join(stateDir, "staging", `probe-${randomUUID()}`);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const source = join(directory, "source");
  const destination = join(directory, "destination");
  writeFileSync(source, "probe", { mode: 0o600 });
  renameSync(source, destination);
  const link = join(directory, "link");
  symlinkSync("destination", link);
  if (readlinkSync(link, "utf8") !== "destination")
    throw new Error("Symlink probe failed");
  const caseUpper = join(directory, "CaseProbe");
  const caseLower = join(directory, "caseprobe");
  writeFileSync(caseUpper, "upper", { mode: 0o600 });
  const caseSensitive = !existsSync(caseLower);
  const composed = join(directory, "caf\u00e9");
  const decomposed = join(directory, "cafe\u0301");
  writeFileSync(composed, "unicode", { mode: 0o600 });
  const unicodeDistinct = !existsSync(decomposed);
  unlinkSync(link);
  unlinkSync(destination);
  unlinkSync(caseUpper);
  unlinkSync(composed);
  (process.getBuiltinModule("node:fs") as typeof import("node:fs")).rmdirSync(
    directory,
  );
  if (lstatSync(root).dev !== lstatSync(stateDir).dev)
    throw new Error("Root and state directory must share a filesystem");
  return {
    atomicRename: true,
    symlink: true,
    caseSensitive,
    unicodeDistinct,
    sameFilesystem: true,
  };
}

export function readEnrollmentRequest(path: string): PeerEnrollmentRequest {
  return JSON.parse(
    readFileSync(resolve(path), "utf8"),
  ) as PeerEnrollmentRequest;
}
