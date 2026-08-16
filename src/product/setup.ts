import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  createProductConfig,
  defaultConfigPath,
  discoverRepositoryUnits,
  ensureLocalLayout,
  saveProductConfig,
} from "./config.js";
import { scanUnit, verifyGitRepository } from "./snapshot.js";
import { HubTransport } from "./transport.js";
import {
  productSchemaVersion,
  type FolderRecord,
  type HubConfig,
  type ProductConfig,
} from "./types.js";

export interface SetupInput {
  readonly mode: "create" | "join";
  readonly root: string;
  readonly folderName: string;
  readonly folderId?: string;
  readonly peerName: string;
  readonly stateDir?: string;
  readonly configPath: string;
  readonly hub: HubConfig;
}

export function setupProduct(input: SetupInput): ProductConfig {
  const root = resolve(input.root);
  const discovered = discoverRepositoryUnits(root, input.mode === "join");
  const transport = new HubTransport(input.hub);
  let units: readonly string[];
  let folderId = input.folderId;
  let folderName = input.folderName;

  if (input.mode === "create") {
    if (folderId !== undefined)
      throw new Error("Create mode generates the folder ID");
    const provisional = createProductConfig({
      folderName,
      peerName: input.peerName,
      root,
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
      units: discovered,
      hub: input.hub,
    });
    folderId = provisional.folderId;
    units = provisional.units;
    for (const unit of units) {
      scanUnit(resolve(root, unit));
      verifyGitRepository(resolve(root, unit));
    }
    const folder: FolderRecord = {
      schemaVersion: productSchemaVersion,
      protocolVersion: productSchemaVersion,
      folderId,
      folderName,
      units,
      createdAt: new Date().toISOString(),
    };
    transport.createFolder(folder);
  } else {
    if (folderId === undefined)
      throw new Error("Join mode requires a folder ID");
    const folder = transport.getFolder(folderId);
    folderName = folder.folderName;
    units = folder.units;
    if (
      discovered.length > 0 &&
      JSON.stringify(discovered) !== JSON.stringify([...units].sort())
    ) {
      throw new Error("Existing repositories do not match the hub folder");
    }
  }

  const config = createProductConfig({
    folderId,
    folderName,
    peerName: input.peerName,
    root,
    ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
    units,
    hub: input.hub,
  });
  ensureLocalLayout(config);
  saveProductConfig(input.configPath, config);
  return config;
}

export async function interactiveSetup(
  configPath = defaultConfigPath(),
): Promise<ProductConfig> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Interactive setup requires a terminal; use setup flags for automation",
    );
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const modeValue = (
      await prompt.question("Create a new folder or join one? [create/join] ")
    ).trim();
    const mode = modeValue === "join" ? "join" : "create";
    const root = (await prompt.question("Code folder path: ")).trim();
    const hubValue = (
      await prompt.question("Hub path or ssh://user@host/absolute/path: ")
    ).trim();
    const peerName =
      (await prompt.question(`Peer name [${hostname()}]: `)).trim() ||
      hostname();
    const folderId =
      mode === "join"
        ? (await prompt.question("Folder ID: ")).trim()
        : undefined;
    const folderName =
      mode === "create"
        ? (await prompt.question("Folder name [code]: ")).trim() || "code"
        : "joined";
    return setupProduct({
      mode,
      root,
      folderName,
      ...(folderId === undefined ? {} : { folderId }),
      peerName,
      configPath,
      hub: parseHubSpec(hubValue, ["codefoldersync"]),
    });
  } finally {
    prompt.close();
  }
}

export function parseHubSpec(
  value: string,
  command: readonly string[],
): HubConfig {
  if (!value.startsWith("ssh://")) {
    return { kind: "local", path: resolve(value) };
  }
  const url = new URL(value);
  if (url.protocol !== "ssh:" || url.hostname.length === 0) {
    throw new Error("SSH hub must use ssh://user@host/absolute/path");
  }
  const user = decodeURIComponent(url.username);
  const host = user.length === 0 ? url.hostname : `${user}@${url.hostname}`;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) throw new Error("SSH hub path must be absolute");
  return { kind: "ssh", host, path, command: [...command] };
}
