import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalJson } from "../v2/hash.js";

export type BackupPlatform = "linux" | "macos";

export interface EncryptedBackupCaptureSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly sourcePlatform: BackupPlatform;
  readonly sourceCodeRoot: string;
  readonly stagingBase: string;
  readonly bundleDirectory: string;
  readonly recipients: readonly string[];
}

export interface SemanticManifestSummary {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly sourcePlatform: BackupPlatform;
  readonly portableSha256: string;
  readonly archiveMetadataSha256: string | null;
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly symlinks: number;
  readonly bytes: number;
  readonly gitBoundaries: number;
  readonly unsupportedObjects: 0;
  readonly readFailures: 0;
}

export interface EncryptedBackupCaptureResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly sourcePlatform: BackupPlatform;
  readonly artifacts: readonly {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly semantic: SemanticManifestSummary;
  readonly tarVersion: string;
  readonly zstdVersion: string;
  readonly ageVersion: string;
  readonly warnings: 0;
  readonly passed: true;
}

interface ManifestHeader {
  readonly record: "header";
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly sourcePlatform: BackupPlatform;
  readonly rootName: "Code";
}

interface DirectoryEntryRecord {
  readonly record: "entry";
  readonly path: string;
  readonly archiveMember: string;
  readonly kind: "directory";
}

interface FileEntryRecord {
  readonly record: "entry";
  readonly path: string;
  readonly archiveMember: string;
  readonly kind: "regular";
  readonly executable: boolean;
  readonly size: number;
  readonly sha256: string;
}

interface SymlinkEntryRecord {
  readonly record: "entry";
  readonly path: string;
  readonly archiveMember: string;
  readonly kind: "symlink";
  readonly target: string;
  readonly targetSha256: string;
}

type EntryRecord = DirectoryEntryRecord | FileEntryRecord | SymlinkEntryRecord;

interface GitRecord {
  readonly record: "git";
  readonly root: string;
  readonly gitDirectoryKind: "directory" | "file";
  readonly head: string | null;
  readonly branch: string | null;
  readonly statusSha256: string;
  readonly trackedSha256: string;
}

interface ManifestFooter {
  readonly record: "footer";
  readonly portableSha256: string;
  readonly archiveMetadataSha256: string | null;
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly symlinks: number;
  readonly bytes: number;
  readonly gitBoundaries: number;
  readonly unsupportedObjects: 0;
  readonly readFailures: 0;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_RECIPIENT = /^age1[0-9a-z]{20,}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const METADATA_PAYLOAD_TYPES = new Set(["x", "g", "L", "K"]);
const VOLATILE_PAX_KEYS = new Set([
  "atime",
  "ctime",
  "LIBARCHIVE.creationtime",
]);
const PATH_PAX_KEYS = new Set(["path", "linkpath", "GNU.sparse.name"]);

export function readEncryptedBackupCaptureSpec(
  path: string,
): EncryptedBackupCaptureSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null)
    throw new Error("Encrypted backup capture spec must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    !safeId(input.runId) ||
    !safeId(input.snapshotId) ||
    !safeId(input.machineId) ||
    (input.sourcePlatform !== "linux" && input.sourcePlatform !== "macos") ||
    typeof input.sourceCodeRoot !== "string" ||
    typeof input.stagingBase !== "string" ||
    typeof input.bundleDirectory !== "string" ||
    !Array.isArray(input.recipients) ||
    input.recipients.some((recipient) => typeof recipient !== "string")
  )
    throw new Error("Encrypted backup capture spec is invalid");
  return value as EncryptedBackupCaptureSpec;
}

export async function captureEncryptedBackup(
  spec: EncryptedBackupCaptureSpec,
): Promise<EncryptedBackupCaptureResult> {
  try {
    return await captureEncryptedBackupUnsafe(spec);
  } catch (error) {
    throw new Error(sanitizedCaptureFailure(error), { cause: error });
  }
}

async function captureEncryptedBackupUnsafe(
  spec: EncryptedBackupCaptureSpec,
): Promise<EncryptedBackupCaptureResult> {
  const validated = validateCaptureSpec(spec);
  const work = join(
    validated.stagingBase,
    `.capture-${spec.snapshotId}-${spec.machineId}`,
  );
  if (existsSync(work)) throw new Error("Backup capture work directory exists");
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(work, "SENTINEL"), `${spec.runId}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const privateDirectory = join(work, "private");
  const bundle = join(work, "bundle");
  mkdirSync(privateDirectory, { mode: 0o700 });
  mkdirSync(bundle, { mode: 0o700 });
  const preManifest = join(privateDirectory, "pre.ndjson");
  const preMembers = join(privateDirectory, "pre.members");
  const finalManifest = join(privateDirectory, "final.ndjson");
  const finalMembers = join(privateDirectory, "final.members");
  const archiveName = `${spec.machineId}-Code.tar.zst.age`;
  const manifestName = `${spec.machineId}-manifest.ndjson.zst.age`;
  const archivePath = join(bundle, archiveName);
  const manifestPath = join(bundle, manifestName);
  let complete = false;
  try {
    const before = await writeSemanticManifest({
      root: validated.sourceCodeRoot,
      output: preManifest,
      membersOutput: preMembers,
      snapshotId: spec.snapshotId,
      machineId: spec.machineId,
      sourcePlatform: spec.sourcePlatform,
      archiveMetadataSha256: null,
    });
    const archiveMetadataSha256 = await createEncryptedArchive({
      sourceCodeRoot: validated.sourceCodeRoot,
      sourcePlatform: spec.sourcePlatform,
      membersPath: preMembers,
      recipients: validated.recipients,
      output: archivePath,
    });
    const after = await writeSemanticManifest({
      root: validated.sourceCodeRoot,
      output: finalManifest,
      membersOutput: finalMembers,
      snapshotId: spec.snapshotId,
      machineId: spec.machineId,
      sourcePlatform: spec.sourcePlatform,
      archiveMetadataSha256,
    });
    const recapturedArchiveMetadataSha256 = await createArchiveMetadataDigest(
      validated.sourceCodeRoot,
      spec.sourcePlatform,
      finalMembers,
    );
    if (
      before.portableSha256 !== after.portableSha256 ||
      (await fileSha256(preMembers)) !== (await fileSha256(finalMembers)) ||
      recapturedArchiveMetadataSha256 !== archiveMetadataSha256
    )
      throw new Error("Code folder changed during backup capture");
    await encryptCompressedFile(
      finalManifest,
      validated.recipients,
      manifestPath,
    );
    const artifacts = await Promise.all(
      [archiveName, manifestName].map(async (name) => {
        const path = join(bundle, name);
        return {
          name,
          size: statSync(path).size,
          sha256: await fileSha256(path),
        };
      }),
    );
    const tarVersion = commandVersion("tar", ["--version"]);
    const zstdVersion = commandVersion("zstd", ["--version"]);
    const ageVersion = commandVersion("age", ["--version"]);
    const witness = {
      schema_version: 1,
      snapshot_id: spec.snapshotId,
      machine_id: spec.machineId,
      artifacts,
      capture: {
        schema_version: 1,
        source_platform: spec.sourcePlatform,
        portable_semantic_sha256: after.portableSha256,
        archive_metadata_sha256: archiveMetadataSha256,
        warnings: 0,
        tools: { age: ageVersion, tar: tarVersion, zstd: zstdVersion },
      },
    };
    writeFileSync(
      join(bundle, "witness.json"),
      `${JSON.stringify(witness)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    rmSync(privateDirectory, { recursive: true });
    renameSync(bundle, validated.bundleDirectory);
    rmSync(work, { recursive: true });
    complete = true;
    return {
      schemaVersion: 1,
      runId: spec.runId,
      snapshotId: spec.snapshotId,
      machineId: spec.machineId,
      sourcePlatform: spec.sourcePlatform,
      artifacts,
      semantic: after,
      tarVersion,
      zstdVersion,
      ageVersion,
      warnings: 0,
      passed: true,
    };
  } finally {
    if (!complete && existsSync(privateDirectory))
      rmSync(privateDirectory, { recursive: true });
  }
}

interface WriteSemanticManifestInput {
  readonly root: string;
  readonly output: string;
  readonly membersOutput: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly sourcePlatform: BackupPlatform;
  readonly archiveMetadataSha256: string | null;
}

export async function writeSemanticManifest(
  input: WriteSemanticManifestInput,
): Promise<SemanticManifestSummary> {
  const root = resolve(input.root);
  if (basename(root) !== "Code")
    throw new Error("Semantic manifest root must be named Code");
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Semantic manifest root must be a physical directory");
  if (!safeId(input.snapshotId) || !safeId(input.machineId))
    throw new Error("Semantic manifest identity is invalid");
  if (
    input.archiveMetadataSha256 !== null &&
    !SHA256.test(input.archiveMetadataSha256)
  )
    throw new Error("Archive metadata digest is invalid");
  const output = resolve(input.output);
  const membersOutput = resolve(input.membersOutput);
  const manifestWriter = createWriteStream(output, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  const membersWriter = createWriteStream(membersOutput, {
    flags: "wx",
    mode: 0o600,
  });
  const portable = createHash("sha256");
  let entries = 0;
  let directories = 0;
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  const gitRoots = new Map<
    string,
    { readonly rawRoot: string; readonly kind: "directory" | "file" }
  >();
  const portablePaths = new Set([""]);

  const writePortable = async (
    record: ManifestHeader | EntryRecord | GitRecord,
  ): Promise<void> => {
    const line = `${canonicalJson(record)}\n`;
    portable.update(line);
    await writeStream(manifestWriter, line);
  };
  const writeMember = async (member: string): Promise<void> => {
    await writeStream(membersWriter, Buffer.from(`${member}\0`));
  };
  const header: ManifestHeader = {
    record: "header",
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    machineId: input.machineId,
    sourcePlatform: input.sourcePlatform,
    rootName: "Code",
  };
  try {
    await writePortable(header);
    const rootEntry: DirectoryEntryRecord = {
      record: "entry",
      path: "",
      archiveMember: "Code",
      kind: "directory",
    };
    await writePortable(rootEntry);
    await writeMember("Code");
    entries += 1;
    directories += 1;
    const visit = async (
      directory: string,
      insideGitMetadata: boolean,
    ): Promise<void> => {
      const beforeDirectory = lstatSync(directory, { bigint: true });
      const children = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) =>
          Buffer.from(left.name).compare(Buffer.from(right.name)),
      );
      for (const child of children) {
        const path = join(directory, child.name);
        const rawLocal = archivePath(relative(root, path));
        const local = portablePath(rawLocal);
        if (portablePaths.has(local))
          throw new Error("Semantic manifest found a portable path alias");
        portablePaths.add(local);
        const archiveMember = `Code/${local}`;
        const rawArchiveMember = `Code/${rawLocal}`;
        const before = lstatSync(path, { bigint: true });
        if (before.dev !== rootStat.dev)
          throw new Error("Semantic manifest refuses to cross a nested mount");
        let record: EntryRecord;
        if (before.isDirectory()) {
          directories += 1;
          record = {
            record: "entry",
            path: local,
            archiveMember,
            kind: "directory",
          };
        } else if (before.isFile()) {
          const digest = await stableFileDigest(path, before);
          const size = safeNumber(before.size, "file size");
          files += 1;
          bytes += size;
          record = {
            record: "entry",
            path: local,
            archiveMember,
            kind: "regular",
            executable: (Number(before.mode) & 0o111) !== 0,
            size,
            sha256: digest,
          };
        } else if (before.isSymbolicLink()) {
          const target = readlinkSync(path);
          const after = lstatSync(path, { bigint: true });
          assertUnchanged(before, after, local);
          symlinks += 1;
          record = {
            record: "entry",
            path: local,
            archiveMember,
            kind: "symlink",
            target,
            targetSha256: createHash("sha256").update(target).digest("hex"),
          };
        } else {
          throw new Error(
            "Semantic manifest found an unsupported filesystem object",
          );
        }
        await writePortable(record);
        await writeMember(rawArchiveMember);
        entries += 1;
        if (child.name === ".git" && before.isSymbolicLink())
          throw new Error(
            "Semantic manifest rejects a symlinked Git directory",
          );
        if (
          !insideGitMetadata &&
          child.name === ".git" &&
          (before.isDirectory() || before.isFile())
        ) {
          const rawBoundary = archivePath(relative(root, directory));
          const boundary = portablePath(rawBoundary);
          gitRoots.set(boundary, {
            rawRoot: rawBoundary,
            kind: before.isDirectory() ? "directory" : "file",
          });
        }
        if (before.isDirectory()) {
          await visit(path, insideGitMetadata || child.name === ".git");
          const after = lstatSync(path, { bigint: true });
          assertUnchanged(before, after, local);
        }
      }
      const afterDirectory = lstatSync(directory, { bigint: true });
      assertUnchanged(
        beforeDirectory,
        afterDirectory,
        portablePath(relative(root, directory)),
      );
    };
    await visit(root, false);
    const sortedGitRoots = [...gitRoots].sort(([left], [right]) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
    for (const [gitRoot, gitDirectory] of sortedGitRoots)
      await writePortable(
        await inspectGitBoundary(
          root,
          gitRoot,
          gitDirectory.rawRoot,
          gitDirectory.kind,
        ),
      );
    const footer: ManifestFooter = {
      record: "footer",
      portableSha256: portable.digest("hex"),
      archiveMetadataSha256: input.archiveMetadataSha256,
      entries,
      directories,
      files,
      symlinks,
      bytes,
      gitBoundaries: sortedGitRoots.length,
      unsupportedObjects: 0,
      readFailures: 0,
    };
    await writeStream(manifestWriter, `${canonicalJson(footer)}\n`);
    await endStream(manifestWriter);
    await endStream(membersWriter);
    return {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      machineId: input.machineId,
      sourcePlatform: input.sourcePlatform,
      portableSha256: footer.portableSha256,
      archiveMetadataSha256: footer.archiveMetadataSha256,
      entries,
      directories,
      files,
      symlinks,
      bytes,
      gitBoundaries: sortedGitRoots.length,
      unsupportedObjects: 0,
      readFailures: 0,
    };
  } catch (error) {
    await Promise.all([
      destroyFileStream(manifestWriter),
      destroyFileStream(membersWriter),
    ]);
    throw error;
  }
}

export async function validateSemanticManifest(
  path: string,
): Promise<SemanticManifestSummary> {
  const stream = createReadStream(resolve(path), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const portable = createHash("sha256");
  let header: ManifestHeader | null = null;
  let footer: ManifestFooter | null = null;
  let phase: "header" | "entry" | "git" | "footer" = "header";
  let entries = 0;
  let directories = 0;
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  let gitBoundaries = 0;
  for await (const line of lines) {
    if (line.length === 0)
      throw new Error("Semantic manifest contains an empty line");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error("Semantic manifest contains invalid JSON", {
        cause: error,
      });
    }
    if (
      typeof value !== "object" ||
      value === null ||
      canonicalJson(value) !== line
    )
      throw new Error("Semantic manifest record is not canonical");
    const input = value as Record<string, unknown>;
    if (input.record === "footer") {
      if (phase === "header" || footer !== null)
        throw new Error("Semantic manifest footer is out of order");
      footer = parseFooter(input);
      phase = "footer";
      continue;
    }
    if (phase === "footer")
      throw new Error("Semantic manifest has records after its footer");
    portable.update(`${line}\n`);
    if (input.record === "header") {
      if (phase !== "header" || header !== null)
        throw new Error("Semantic manifest header is out of order");
      header = parseHeader(input);
      phase = "entry";
    } else if (input.record === "entry") {
      if (phase !== "entry")
        throw new Error("Semantic manifest entry is out of order");
      const entry = parseEntry(input);
      if (entries === 0 && entry.path !== "")
        throw new Error("Semantic manifest is missing its Code root entry");
      entries += 1;
      if (entry.kind === "directory") directories += 1;
      else if (entry.kind === "regular") {
        files += 1;
        bytes += entry.size;
      } else symlinks += 1;
    } else if (input.record === "git") {
      if (phase !== "entry" && phase !== "git")
        throw new Error("Semantic manifest Git record is out of order");
      parseGit(input);
      phase = "git";
      gitBoundaries += 1;
    } else {
      throw new Error("Semantic manifest record type is unsupported");
    }
  }
  if (header === null || footer === null)
    throw new Error("Semantic manifest is incomplete");
  const digest = portable.digest("hex");
  if (
    footer.portableSha256 !== digest ||
    footer.entries !== entries ||
    footer.directories !== directories ||
    footer.files !== files ||
    footer.symlinks !== symlinks ||
    footer.bytes !== bytes ||
    footer.gitBoundaries !== gitBoundaries ||
    footer.unsupportedObjects !== 0 ||
    footer.readFailures !== 0
  )
    throw new Error("Semantic manifest footer does not match its records");
  return {
    schemaVersion: 1,
    snapshotId: header.snapshotId,
    machineId: header.machineId,
    sourcePlatform: header.sourcePlatform,
    portableSha256: digest,
    archiveMetadataSha256: footer.archiveMetadataSha256,
    entries,
    directories,
    files,
    symlinks,
    bytes,
    gitBoundaries,
    unsupportedObjects: 0,
    readFailures: 0,
  };
}

interface PendingTarPayload {
  readonly type: string;
  readonly size: number;
  remaining: number;
  contentRemaining: number;
  readonly chunks: Buffer[];
}

/**
 * Hashes recoverable tar metadata without hashing file bodies or volatile
 * filesystem observations. PAX atime/ctime, archive creation time, and
 * macOS provenance are deliberately excluded because extraction changes them.
 */
export class TarMetadataHasher extends Transform {
  readonly #hash = createHash("sha256");
  #pending = Buffer.alloc(0);
  #payload: PendingTarPayload | null = null;
  readonly #globalPax = new Map<string, Buffer>();
  readonly #entryPax = new Map<string, Buffer>();
  #longPath: Buffer | null = null;
  #longLink: Buffer | null = null;
  #complete = false;
  #digest: string | null = null;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    try {
      this.#consume(Buffer.from(chunk));
      callback(null, chunk);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.#payload !== null || this.#pending.length !== 0)
        throw new Error("Tar metadata stream ended mid-record");
      if (
        this.#entryPax.size > 0 ||
        this.#longPath !== null ||
        this.#longLink !== null
      )
        throw new Error("Tar metadata stream ended before its target entry");
      this.#digest = this.#hash.digest("hex");
      this.#complete = true;
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  digest(): string {
    if (!this.#complete || this.#digest === null)
      throw new Error(
        "Tar metadata digest is unavailable before stream completion",
      );
    return this.#digest;
  }

  #consume(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    while (this.#pending.length > 0) {
      if (this.#payload !== null) {
        const consumed = Math.min(
          this.#payload.remaining,
          this.#pending.length,
        );
        const contentBytes = Math.min(this.#payload.contentRemaining, consumed);
        if (contentBytes > 0)
          this.#payload.chunks.push(this.#pending.subarray(0, contentBytes));
        this.#pending = this.#pending.subarray(consumed);
        this.#payload.remaining -= consumed;
        this.#payload.contentRemaining -= contentBytes;
        if (this.#payload.remaining === 0) this.#finishPayload();
        continue;
      }
      if (this.#pending.length < 512) return;
      const header = this.#pending.subarray(0, 512);
      this.#pending = this.#pending.subarray(512);
      if (header.every((value) => value === 0)) continue;
      const size = tarNumber(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] ?? 0);
      if (!METADATA_PAYLOAD_TYPES.has(type))
        this.#hashEntry(header, type, size);
      const paddedSize = Math.ceil(size / 512) * 512;
      this.#payload = {
        type,
        size,
        remaining: paddedSize,
        contentRemaining: METADATA_PAYLOAD_TYPES.has(type) ? size : 0,
        chunks: [],
      };
      if (paddedSize === 0) this.#finishPayload();
    }
  }

  #finishPayload(): void {
    const payload = this.#payload;
    if (payload === null) throw new Error("Tar payload state is invalid");
    this.#payload = null;
    if (!METADATA_PAYLOAD_TYPES.has(payload.type)) return;
    const content = Buffer.concat(payload.chunks, payload.size);
    if (payload.type === "x") mergePax(this.#entryPax, parsePax(content));
    else if (payload.type === "g") mergePax(this.#globalPax, parsePax(content));
    else if (payload.type === "L") this.#longPath = trimTarText(content);
    else this.#longLink = trimTarText(content);
  }

  #hashEntry(header: Buffer, type: string, size: number): void {
    const pax = new Map(this.#globalPax);
    mergePax(pax, this.#entryPax);
    const headerName = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const storedPath = prefix === "" ? headerName : `${prefix}/${headerName}`;
    const path = normalizedTarText(
      pax.get("path") ?? this.#longPath ?? Buffer.from(storedPath, "utf8"),
    );
    const link = normalizedTarText(
      pax.get("linkpath") ??
        this.#longLink ??
        Buffer.from(tarText(header.subarray(157, 257)), "utf8"),
    );
    const attributes = [...pax.entries()]
      .filter(([key]) => includedPaxKey(key))
      .map(
        ([key, value]) =>
          [
            key,
            (PATH_PAX_KEYS.has(key)
              ? Buffer.from(normalizedTarText(value), "utf8")
              : value
            ).toString("base64"),
          ] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    const record = {
      record: "tar-metadata",
      path,
      type,
      mode: tarNumber(header.subarray(100, 108)),
      uid: tarNumber(header.subarray(108, 116)),
      gid: tarNumber(header.subarray(116, 124)),
      size,
      mtime: tarNumber(header.subarray(136, 148)),
      link,
      user: tarText(header.subarray(265, 297)),
      group: tarText(header.subarray(297, 329)),
      deviceMajor: tarNumber(header.subarray(329, 337)),
      deviceMinor: tarNumber(header.subarray(337, 345)),
      attributes,
    };
    this.#hash.update(`${canonicalJson(record)}\n`);
    this.#entryPax.clear();
    this.#longPath = null;
    this.#longLink = null;
  }
}

function parsePax(payload: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 0;
  while (offset < payload.length) {
    const separator = payload.indexOf(0x20, offset);
    if (separator < 0) throw new Error("PAX record has no length separator");
    const lengthText = payload.subarray(offset, separator).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText))
      throw new Error("PAX record length is invalid");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > payload.length || length < 4)
      throw new Error("PAX record exceeds its payload");
    const record = payload.subarray(separator + 1, end);
    if (record.at(-1) !== 0x0a) throw new Error("PAX record is unterminated");
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("PAX record has no key");
    const key = record.subarray(0, equals).toString("utf8");
    if (!/^[\u0021-\u007e]+$/u.test(key))
      throw new Error("PAX record key is invalid");
    result.set(key, record.subarray(equals + 1, -1));
    offset = end;
  }
  return result;
}

function mergePax(
  target: Map<string, Buffer>,
  source: ReadonlyMap<string, Buffer>,
): void {
  for (const [key, value] of source) target.set(key, value);
}

function includedPaxKey(key: string): boolean {
  if (VOLATILE_PAX_KEYS.has(key)) return false;
  return !/^(?:LIBARCHIVE|SCHILY)\.xattr\.com\.apple\.provenance$/u.test(key);
}

function tarText(value: Buffer): string {
  const terminator = value.indexOf(0);
  return value
    .subarray(0, terminator < 0 ? value.length : terminator)
    .toString("utf8");
}

function trimTarText(value: Buffer): Buffer {
  let end = value.length;
  while (end > 0 && (value[end - 1] === 0 || value[end - 1] === 0x0a)) end -= 1;
  return value.subarray(0, end);
}

function normalizedTarText(value: Buffer): string {
  return tarText(value).normalize("NFC");
}

export async function createArchiveMetadataDigest(
  sourceCodeRoot: string,
  sourcePlatform: BackupPlatform,
  membersPath: string,
): Promise<string> {
  const tar = spawn("tar", tarArguments(sourceCodeRoot, sourcePlatform), {
    env: commandEnvironment(sourcePlatform),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (tar.stdin === null || tar.stdout === null)
    throw new Error("Tar metadata pipeline could not connect");
  const hasher = new TarMetadataHasher();
  const sink = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
  const diagnostics = collectBounded(tar.stderr);
  await Promise.all([
    pipeline(createReadStream(resolve(membersPath)), tar.stdin),
    pipeline(tar.stdout, hasher, sink),
    requireCleanChild(tar, "tar", diagnostics),
  ]);
  return hasher.digest();
}

interface ValidatedCaptureSpec {
  readonly sourceCodeRoot: string;
  readonly stagingBase: string;
  readonly bundleDirectory: string;
  readonly recipients: readonly [string, string];
}

function validateCaptureSpec(
  spec: EncryptedBackupCaptureSpec,
): ValidatedCaptureSpec {
  if (
    spec.schemaVersion !== 1 ||
    !safeId(spec.runId) ||
    !safeId(spec.snapshotId) ||
    !safeId(spec.machineId)
  )
    throw new Error("Backup capture identity is invalid");
  if (spec.sourcePlatform !== currentPlatform())
    throw new Error("Backup capture platform does not match this machine");
  const sourceCodeRoot = resolve(spec.sourceCodeRoot);
  const stagingBase = resolve(spec.stagingBase);
  const bundleDirectory = resolve(spec.bundleDirectory);
  if (basename(sourceCodeRoot) !== "Code")
    throw new Error("Backup source root must be named Code");
  const sourceStat = lstatSync(sourceCodeRoot);
  const stagingStat = lstatSync(stagingBase);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error("Backup source must be a physical directory");
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink())
    throw new Error("Backup staging base must be a physical directory");
  if (readFileSync(join(stagingBase, "SENTINEL"), "utf8") !== `${spec.runId}\n`)
    throw new Error("Backup staging sentinel does not match the run ID");
  assertBelow(bundleDirectory, stagingBase, "Backup bundle");
  if (existsSync(bundleDirectory)) throw new Error("Backup bundle exists");
  if (
    contained(sourceCodeRoot, stagingBase) ||
    contained(stagingBase, sourceCodeRoot)
  )
    throw new Error("Backup staging and source roots must be disjoint");
  const recipients = [...new Set(spec.recipients)];
  if (
    recipients.length !== 2 ||
    recipients.some((value) => !SAFE_RECIPIENT.test(value))
  )
    throw new Error("Backup capture requires two distinct age recipients");
  return {
    sourceCodeRoot,
    stagingBase,
    bundleDirectory,
    recipients: [recipients[0]!, recipients[1]!],
  };
}

async function createEncryptedArchive(input: {
  readonly sourceCodeRoot: string;
  readonly sourcePlatform: BackupPlatform;
  readonly membersPath: string;
  readonly recipients: readonly [string, string];
  readonly output: string;
}): Promise<string> {
  const outputDescriptor = openSync(input.output, "wx", 0o600);
  const tar = spawn(
    "tar",
    tarArguments(input.sourceCodeRoot, input.sourcePlatform),
    {
      env: commandEnvironment(input.sourcePlatform),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const zstd = spawn(
    "zstd",
    ["--compress", "--stdout", "--quiet", "-T0", "-3"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ageArguments = ["--encrypt"];
  for (const recipient of input.recipients)
    ageArguments.push("--recipient", recipient);
  const age = spawn("age", ageArguments, {
    stdio: ["pipe", outputDescriptor, "pipe"],
  });
  closeSync(outputDescriptor);
  if (
    tar.stdin === null ||
    tar.stdout === null ||
    zstd.stdin === null ||
    zstd.stdout === null ||
    age.stdin === null
  )
    throw new Error("Encrypted archive pipeline could not connect");
  const hasher = new TarMetadataHasher();
  const tarDiagnostics = collectBounded(tar.stderr);
  const zstdDiagnostics = collectBounded(zstd.stderr);
  const ageDiagnostics = collectBounded(age.stderr);
  await Promise.all([
    pipeline(createReadStream(resolve(input.membersPath)), tar.stdin),
    pipeline(tar.stdout, hasher, zstd.stdin),
    pipeline(zstd.stdout, age.stdin),
    requireCleanChild(tar, "tar", tarDiagnostics),
    requireCleanChild(zstd, "zstd", zstdDiagnostics),
    requireCleanChild(age, "age", ageDiagnostics),
  ]);
  return hasher.digest();
}

async function encryptCompressedFile(
  input: string,
  recipients: readonly [string, string],
  output: string,
): Promise<void> {
  const outputDescriptor = openSync(output, "wx", 0o600);
  const zstd = spawn(
    "zstd",
    ["--compress", "--stdout", "--quiet", "-T0", "-3"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ageArguments = ["--encrypt"];
  for (const recipient of recipients)
    ageArguments.push("--recipient", recipient);
  const age = spawn("age", ageArguments, {
    stdio: ["pipe", outputDescriptor, "pipe"],
  });
  closeSync(outputDescriptor);
  if (zstd.stdin === null || zstd.stdout === null || age.stdin === null)
    throw new Error("Encrypted manifest pipeline could not connect");
  const zstdDiagnostics = collectBounded(zstd.stderr);
  const ageDiagnostics = collectBounded(age.stderr);
  await Promise.all([
    pipeline(createReadStream(resolve(input)), zstd.stdin),
    pipeline(zstd.stdout, age.stdin),
    requireCleanChild(zstd, "zstd", zstdDiagnostics),
    requireCleanChild(age, "age", ageDiagnostics),
  ]);
}

function tarArguments(
  sourceCodeRoot: string,
  platform: BackupPlatform,
): string[] {
  const parent = dirname(resolve(sourceCodeRoot));
  if (platform === "linux")
    return [
      "--create",
      "--format=pax",
      "--file=-",
      `--directory=${parent}`,
      "--null",
      "--no-recursion",
      "--numeric-owner",
      "--acls",
      "--xattrs",
      "--sparse",
      "--sparse-version=1.0",
      "--pax-option=delete=atime,delete=ctime",
      "--warning=all",
      "--check-links",
      "--files-from=-",
    ];
  return [
    "-c",
    "--format=pax",
    "--acls",
    "--xattrs",
    "--fflags",
    "--no-mac-metadata",
    "-f",
    "-",
    "-C",
    parent,
    "--null",
    "--no-recursion",
    "-T",
    "-",
  ];
}

function commandEnvironment(platform: BackupPlatform): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: "C",
    TZ: "UTC",
    ...(platform === "macos" ? { COPYFILE_DISABLE: "1" } : {}),
  };
}

async function inspectGitBoundary(
  codeRoot: string,
  localRoot: string,
  rawRoot: string,
  gitDirectoryKind: "directory" | "file",
): Promise<GitRecord> {
  const repository = rawRoot === "" ? codeRoot : join(codeRoot, rawRoot);
  const gitDirectory = gitText(
    repository,
    ["rev-parse", "--absolute-git-dir"],
    true,
  );
  const commonDirectory = gitText(
    repository,
    ["rev-parse", "--git-common-dir"],
    true,
  );
  for (const candidate of [gitDirectory, commonDirectory]) {
    if (candidate === null)
      throw new Error("Git boundary has no repository directory");
    const absolute = resolve(repository, candidate);
    if (!contained(absolute, codeRoot))
      throw new Error("Semantic manifest rejects an external Git directory");
  }
  const head = gitText(repository, ["rev-parse", "--verify", "HEAD"], false);
  const branch = gitText(
    repository,
    ["symbolic-ref", "--quiet", "HEAD"],
    false,
  );
  const statusSha256 = await gitDigest(repository, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]);
  const trackedSha256 = await gitDigest(repository, [
    "ls-files",
    "--stage",
    "-z",
  ]);
  return {
    record: "git",
    root: localRoot,
    gitDirectoryKind,
    head,
    branch,
    statusSha256,
    trackedSha256,
  };
}

function gitText(
  repository: string,
  arguments_: readonly string[],
  required: boolean,
): string | null {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    if (!required) return null;
    throw new Error("Git semantic inspection failed");
  }
  if (result.stderr.length > 0)
    throw new Error("Git semantic inspection emitted a warning");
  return result.stdout.replace(/\r?\n$/u, "");
}

async function gitDigest(
  repository: string,
  arguments_: readonly string[],
): Promise<string> {
  const child = spawn("git", ["-C", repository, ...arguments_], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout === null)
    throw new Error("Git semantic digest could not connect");
  const hash = createHash("sha256");
  const diagnostics = collectBounded(child.stderr);
  const consume = (async (): Promise<void> => {
    for await (const chunk of child.stdout!) hash.update(chunk);
  })();
  await Promise.all([consume, requireCleanChild(child, "git", diagnostics)]);
  return hash.digest("hex");
}

async function stableFileDigest(
  path: string,
  before: BigIntStats,
): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  const after = lstatSync(path, { bigint: true });
  assertUnchanged(before, after, basename(path));
  return hash.digest("hex");
}

function assertUnchanged(
  before: BigIntStats,
  after: BigIntStats,
  _label: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error("A path changed during semantic inventory");
}

function sanitizedCaptureFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/changed during (?:backup capture|semantic inventory)/u.test(message))
    return "Code folder changed during backup capture";
  if (/nested mount/u.test(message))
    return "Backup capture rejected a nested mount";
  if (/unsupported filesystem object/u.test(message))
    return "Backup capture rejected an unsupported filesystem object";
  if (/Git/u.test(message))
    return "Backup capture rejected an unsafe Git boundary";
  if (/failed or emitted a warning/u.test(message))
    return "Backup capture tool failed or emitted a warning";
  if (/requires two distinct age recipients/u.test(message))
    return "Backup capture requires two distinct age recipients";
  return "Backup capture failed without publishing path details";
}

function parseHeader(input: Record<string, unknown>): ManifestHeader {
  if (
    input.record !== "header" ||
    input.schemaVersion !== 1 ||
    !safeId(input.snapshotId) ||
    !safeId(input.machineId) ||
    (input.sourcePlatform !== "linux" && input.sourcePlatform !== "macos") ||
    input.rootName !== "Code"
  )
    throw new Error("Semantic manifest header is invalid");
  return input as unknown as ManifestHeader;
}

function parseEntry(input: Record<string, unknown>): EntryRecord {
  if (
    input.record !== "entry" ||
    typeof input.path !== "string" ||
    typeof input.archiveMember !== "string" ||
    !validManifestPath(input.path) ||
    input.archiveMember !== (input.path === "" ? "Code" : `Code/${input.path}`)
  )
    throw new Error("Semantic manifest entry path is invalid");
  if (input.kind === "directory")
    return input as unknown as DirectoryEntryRecord;
  if (
    input.kind === "regular" &&
    typeof input.executable === "boolean" &&
    Number.isSafeInteger(input.size) &&
    Number(input.size) >= 0 &&
    typeof input.sha256 === "string" &&
    SHA256.test(input.sha256)
  )
    return input as unknown as FileEntryRecord;
  if (
    input.kind === "symlink" &&
    typeof input.target === "string" &&
    typeof input.targetSha256 === "string" &&
    input.targetSha256 ===
      createHash("sha256").update(input.target).digest("hex")
  )
    return input as unknown as SymlinkEntryRecord;
  throw new Error("Semantic manifest entry is invalid");
}

function parseGit(input: Record<string, unknown>): GitRecord {
  if (
    input.record !== "git" ||
    typeof input.root !== "string" ||
    !validManifestPath(input.root) ||
    (input.gitDirectoryKind !== "directory" &&
      input.gitDirectoryKind !== "file") ||
    (input.head !== null && typeof input.head !== "string") ||
    (input.branch !== null && typeof input.branch !== "string") ||
    typeof input.statusSha256 !== "string" ||
    !SHA256.test(input.statusSha256) ||
    typeof input.trackedSha256 !== "string" ||
    !SHA256.test(input.trackedSha256)
  )
    throw new Error("Semantic manifest Git record is invalid");
  return input as unknown as GitRecord;
}

function parseFooter(input: Record<string, unknown>): ManifestFooter {
  const counts = [
    input.entries,
    input.directories,
    input.files,
    input.symlinks,
    input.bytes,
    input.gitBoundaries,
  ];
  if (
    input.record !== "footer" ||
    typeof input.portableSha256 !== "string" ||
    !SHA256.test(input.portableSha256) ||
    (input.archiveMetadataSha256 !== null &&
      (typeof input.archiveMetadataSha256 !== "string" ||
        !SHA256.test(input.archiveMetadataSha256))) ||
    counts.some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
    input.unsupportedObjects !== 0 ||
    input.readFailures !== 0
  )
    throw new Error("Semantic manifest footer is invalid");
  return input as unknown as ManifestFooter;
}

function tarNumber(value: Buffer): number {
  if ((value[0] ?? 0) & 0x80) {
    let result = BigInt((value[0] ?? 0) & 0x7f);
    for (const byte of value.subarray(1))
      result = (result << 8n) | BigInt(byte);
    return safeNumber(result, "tar size");
  }
  const text = value.toString("ascii").replace(/\0.*$/u, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text))
    throw new Error("Tar header contains an invalid size");
  return safeNumber(BigInt(`0o${text}`), "tar size");
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} exceeds the safe integer range`);
  return Number(value);
}

function portablePath(path: string): string {
  return archivePath(path).normalize("NFC");
}

function archivePath(path: string): string {
  return path.split(sep).join("/");
}

function validManifestPath(path: string): boolean {
  return (
    !path.includes("\0") &&
    !isAbsolute(path) &&
    path.split("/").every((part) => part !== ".." && part !== ".")
  );
}

function contained(path: string, root: string): boolean {
  const target = resolve(path);
  const boundary = resolve(root);
  return target === boundary || target.startsWith(`${boundary}${sep}`);
}

function assertBelow(path: string, root: string, label: string): void {
  const target = resolve(path);
  const boundary = resolve(root);
  if (target === boundary || !target.startsWith(`${boundary}${sep}`))
    throw new Error(`${label} must be below the sentinel base`);
}

function currentPlatform(): BackupPlatform {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  throw new Error(`Unsupported backup platform: ${process.platform}`);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk);
  return hash.digest("hex");
}

function commandVersion(
  command: string,
  arguments_: readonly string[],
): string {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.stderr.length > 0)
    throw new Error(`Could not verify ${command} version`);
  const line = result.stdout
    .split(/\r?\n/u)
    .find((value) => value.trim().length > 0);
  if (line === undefined) throw new Error(`${command} returned no version`);
  return line.trim();
}

interface BoundedDiagnostics {
  readonly output: Buffer;
  readonly overflow: boolean;
}

async function collectBounded(
  stream: NodeJS.ReadableStream | null,
): Promise<BoundedDiagnostics> {
  if (stream === null) return { output: Buffer.alloc(0), overflow: false };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes <= 1024 * 1024) chunks.push(value);
    else overflow = true;
  }
  return { output: Buffer.concat(chunks), overflow };
}

async function requireCleanChild(
  child: ChildProcess,
  label: string,
  diagnostics: Promise<BoundedDiagnostics>,
): Promise<void> {
  const [status, captured] = await Promise.all([
    closeStatus(child),
    diagnostics,
  ]);
  if (status !== 0 || captured.overflow || captured.output.length > 0)
    throw new Error(`${label} failed or emitted a warning`);
}

function closeStatus(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  });
}

async function writeStream(
  stream: ReturnType<typeof createWriteStream>,
  value: string | Buffer,
): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => {
    const cleanup = (): void => {
      stream.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once("error", onError);
    stream.write(value, (error) => {
      cleanup();
      if (error) reject(error);
      else resolveWrite();
    });
  });
}

async function endStream(
  stream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  await new Promise<void>((resolveEnd, reject) => {
    const cleanup = (): void => {
      stream.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once("error", onError);
    stream.end(() => {
      cleanup();
      resolveEnd();
    });
  });
}

async function destroyFileStream(
  stream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolveClose) => {
    stream.once("close", resolveClose);
    stream.destroy();
  });
}
