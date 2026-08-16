import { createInterface } from "node:readline/promises";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createConfig,
  defaultConfigPath,
  discoverRepositories,
  ensureLocalLayout,
  parseHubSpec,
  readIgnorePatterns,
  saveConfig,
} from "./config.js";
import { syncFolderV2 } from "./engine.js";
import { LocalState } from "./state.js";
import { HubTransport } from "./transport.js";
import {
  protocolVersion,
  schemaVersion,
  type HubConfig,
  type ProductConfig,
  type SyncSummary,
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
  readonly initialSync?: boolean;
}

export interface SetupResult {
  readonly config: ProductConfig;
  readonly filesystem: ReturnType<typeof probeFilesystem>;
  readonly sync: SyncSummary | null;
}

export async function setupProductV2(input: SetupInput): Promise<SetupResult> {
  const root = resolve(input.root);
  if (
    input.hub.kind === "local" &&
    (resolve(input.hub.path) === root ||
      resolve(input.hub.path).startsWith(`${root}${sep}`))
  ) {
    throw new Error("Hub must be outside the synchronized root");
  }
  if (input.mode === "join") assertEmptyJoinRoot(root);
  const localRepositories = discoverRepositories(root, input.mode === "join");
  await using transport = await HubTransport.connect(input.hub);
  let config: ProductConfig;
  if (input.mode === "create") {
    if (input.folderId !== undefined)
      throw new Error("Create mode generates the folder ID");
    config = createConfig({
      folderName: input.folderName,
      peerName: input.peerName,
      root,
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
      repositories: localRepositories,
      hub: input.hub,
    });
    await transport.createFolder({
      schemaVersion,
      protocolVersion,
      folderId: config.folderId,
      folderName: config.folderName,
      repositories: config.repositories,
      ignorePatterns: readIgnorePatterns(root),
      createdAt: new Date().toISOString(),
    });
  } else {
    if (input.folderId === undefined)
      throw new Error("Join mode requires a folder ID");
    const folder = await transport.getFolder(input.folderId);
    config = createConfig({
      folderId: folder.folderId,
      folderName: folder.folderName,
      peerName: input.peerName,
      root,
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
      repositories: folder.repositories,
      hub: input.hub,
    });
    if (folder.ignorePatterns.length > 0) {
      writeFileSync(
        join(root, ".codefoldersyncignore"),
        `${folder.ignorePatterns.join("\n")}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
  }
  ensureLocalLayout(config);
  const filesystem = probeFilesystem(config);
  saveConfig(input.configPath, config);
  if (input.mode === "join") {
    using state = new LocalState(config);
    state.markInitialJoin();
  }
  const sync = input.initialSync === false ? null : await syncFolderV2(config);
  if (
    sync !== null &&
    (sync.status === "inconclusive" || sync.status === "offline")
  )
    throw new Error(
      `Initial synchronization failed: ${sync.reasons.join("; ")}`,
    );
  return { config, filesystem, sync };
}

export async function interactiveSetupV2(
  configPath = defaultConfigPath(),
): Promise<SetupResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Interactive setup requires a terminal; use flags for automation",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const modeAnswer = (
      await prompt.question("Create a folder or join one? [create/join] ")
    ).trim();
    const mode = modeAnswer === "join" ? "join" : "create";
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
    const confirmed = (
      await prompt.question(
        `Synchronize ${resolve(root)} using ${hubValue}? [yes/no] `,
      )
    )
      .trim()
      .toLowerCase();
    if (confirmed !== "yes" && confirmed !== "y")
      throw new Error("Setup cancelled");
    return setupProductV2({
      mode,
      root,
      folderName,
      ...(folderId === undefined ? {} : { folderId }),
      peerName,
      configPath,
      hub: parseHubSpec(hubValue),
    });
  } finally {
    prompt.close();
  }
}

function assertEmptyJoinRoot(root: string): void {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return;
  }
  if (!lstatSync(root).isDirectory())
    throw new Error("Join root must be a directory");
  if (readdirSync(root).length > 0) throw new Error("Join root must be empty");
}

function probeFilesystem(config: ProductConfig): {
  readonly caseSensitive: boolean;
  readonly unicodeAliases: boolean;
  readonly symlinks: boolean;
  readonly atomicRename: boolean;
  readonly fsync: boolean;
} {
  const probe = join(config.root, `.codefoldersync-probe-${randomUUID()}`);
  mkdirSync(probe, { recursive: false, mode: 0o700 });
  const lower = join(probe, "case-probe");
  const upper = join(probe, "CASE-PROBE");
  const composed = join(probe, "é");
  const decomposed = join(probe, "e\u0301");
  const source = join(probe, "source");
  const renamed = join(probe, "renamed");
  const link = join(probe, "link");
  let symlinks = false;
  let fsync = false;
  let atomicRename = false;
  try {
    writeFileSync(lower, "lower", { flag: "wx" });
    const caseSensitive = !existsSync(upper);
    writeFileSync(composed, "unicode", { flag: "wx" });
    const unicodeAliases = existsSync(decomposed);
    writeFileSync(source, "rename", { flag: "wx" });
    renameSync(source, renamed);
    atomicRename = existsSync(renamed) && !existsSync(source);
    try {
      symlinkSync("missing-target", link);
      symlinks = readlinkSync(link) === "missing-target";
    } catch {
      symlinks = false;
    }
    const descriptor = openSync(renamed, "r");
    try {
      fsyncSync(descriptor);
      fsync = true;
    } finally {
      closeSync(descriptor);
    }
    return { caseSensitive, unicodeAliases, symlinks, atomicRename, fsync };
  } finally {
    for (const target of [
      link,
      renamed,
      source,
      decomposed,
      composed,
      upper,
      lower,
    ]) {
      if (existsSync(target) || isSymlink(target)) unlinkSync(target);
    }
    // The probe directory is empty and was created by this invocation.
    const moved = join(
      config.stateDir,
      "recovery",
      `setup-probe-${randomUUID()}`,
    );
    renameSync(probe, moved);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
