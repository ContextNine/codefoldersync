import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createTreeWitness, type TreeWitness } from "./acceptance.js";
import {
  createArchiveMetadataDigest,
  validateSemanticManifest,
  writeSemanticManifest,
} from "./backup.js";

export interface EncryptedMasterRestoreSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly archivePlatform: "linux" | "macos";
  readonly destinationBase: string;
  readonly destination: string;
  readonly bundleDirectory: string;
  readonly identityPath: string;
}

export interface EncryptedMasterRestoreResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly archiveCiphertextSha256: string;
  readonly archiveCiphertextBytes: number;
  readonly manifestCiphertextSha256: string;
  readonly manifestCiphertextBytes: number;
  readonly portableSemanticSha256: string;
  readonly platformMetadataVerified: boolean;
  readonly ignoredArchiveMetadataRecords: number;
  readonly protected: true;
  readonly witness: TreeWitness;
}

interface CiphertextWitness {
  readonly schema_version: 1;
  readonly snapshot_id: string;
  readonly machine_id: string;
  readonly artifacts: readonly {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

export function readEncryptedMasterRestoreSpec(
  path: string,
): EncryptedMasterRestoreSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null)
    throw new Error("Encrypted restore spec must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    !safeId(input.runId) ||
    !safeId(input.snapshotId) ||
    !safeId(input.machineId) ||
    (input.archivePlatform !== "linux" && input.archivePlatform !== "macos") ||
    typeof input.destinationBase !== "string" ||
    typeof input.destination !== "string" ||
    typeof input.bundleDirectory !== "string" ||
    typeof input.identityPath !== "string"
  )
    throw new Error("Encrypted restore spec is invalid");
  return value as EncryptedMasterRestoreSpec;
}

export async function restoreEncryptedMaster(
  spec: EncryptedMasterRestoreSpec,
): Promise<EncryptedMasterRestoreResult> {
  try {
    return await restoreEncryptedMasterUnsafe(spec);
  } catch (error) {
    throw new Error(sanitizedRestoreFailure(error), { cause: error });
  }
}

async function restoreEncryptedMasterUnsafe(
  spec: EncryptedMasterRestoreSpec,
): Promise<EncryptedMasterRestoreResult> {
  const destinationBase = resolve(spec.destinationBase);
  const destination = resolve(spec.destination);
  assertContained(destination, destinationBase, "Restore destination");
  const baseStat = lstatSync(destinationBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error("Restore base must be a physical directory");
  if (
    readFileSync(join(destinationBase, "SENTINEL"), "utf8") !==
    `${spec.runId}\n`
  )
    throw new Error("Restore base sentinel does not match the run ID");
  if (existsSync(destination)) throw new Error("Restore destination exists");
  const staging = `${destination}.staging-${spec.runId}`;
  if (existsSync(staging)) throw new Error("Restore staging exists");

  const bundle = resolve(spec.bundleDirectory);
  const witness = parseCiphertextWitness(
    JSON.parse(readFileSync(join(bundle, "witness.json"), "utf8")) as unknown,
  );
  if (
    witness.snapshot_id !== spec.snapshotId ||
    witness.machine_id !== spec.machineId
  )
    throw new Error("Ciphertext witness does not match the restore spec");
  if (witness.artifacts.length !== 2)
    throw new Error("Ciphertext witness must bind exactly two artifacts");
  const entries = readdirSync(bundle, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()))
    throw new Error("Ciphertext bundle must contain flat regular files");
  const archiveArtifact = exactlyOneArtifact(witness, (value) =>
    value.name.endsWith(".tar.zst.age"),
  );
  const manifestArtifact = exactlyOneArtifact(witness, (value) =>
    value.name.endsWith("-manifest.ndjson.zst.age"),
  );
  const expectedNames = new Set([
    "witness.json",
    ...witness.artifacts.map((value) => value.name),
  ]);
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !expectedNames.has(entry.name))
  )
    throw new Error("Ciphertext bundle entries do not match its witness");
  for (const artifact of witness.artifacts) {
    const path = join(bundle, artifact.name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Ciphertext artifact must be a regular file");
    if (metadata.size !== artifact.size)
      throw new Error("Ciphertext artifact size does not match its witness");
    if ((await fileSha256(path)) !== artifact.sha256)
      throw new Error("Ciphertext artifact digest does not match its witness");
  }
  const archive = join(bundle, archiveArtifact.name);
  const encryptedManifest = join(bundle, manifestArtifact.name);

  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  const expectedManifestPath = join(staging, "expected-manifest.ndjson");
  await decryptCompressedFile(
    encryptedManifest,
    resolve(spec.identityPath),
    expectedManifestPath,
  );
  const expectedManifest = await validateSemanticManifest(expectedManifestPath);
  if (
    expectedManifest.snapshotId !== spec.snapshotId ||
    expectedManifest.machineId !== spec.machineId ||
    expectedManifest.sourcePlatform !== spec.archivePlatform ||
    expectedManifest.archiveMetadataSha256 === null
  )
    throw new Error("Semantic manifest does not match the restore spec");
  const ignoredArchiveMetadataRecords = await extractArchive(
    archive,
    resolve(spec.identityPath),
    staging,
    spec.archivePlatform,
  );
  const payload = join(staging, "payload");
  const payloadEntries = readdirSync(payload, { withFileTypes: true });
  if (
    payloadEntries.length !== 1 ||
    payloadEntries[0]?.name !== "Code" ||
    !payloadEntries[0].isDirectory()
  )
    throw new Error("Encrypted archive must contain one Code directory");
  const actualManifestPath = join(staging, "actual-manifest.ndjson");
  const actualMembersPath = join(staging, "actual-members");
  const actualManifest = await writeSemanticManifest({
    root: join(payload, "Code"),
    output: actualManifestPath,
    membersOutput: actualMembersPath,
    snapshotId: spec.snapshotId,
    machineId: spec.machineId,
    sourcePlatform: spec.archivePlatform,
    archiveMetadataSha256: null,
  });
  if (actualManifest.portableSha256 !== expectedManifest.portableSha256)
    throw new Error(
      "Restored tree differs from its portable semantic manifest",
    );
  const platformMetadataVerified = currentPlatform() === spec.archivePlatform;
  if (platformMetadataVerified) {
    const actualArchiveMetadata = await createArchiveMetadataDigest(
      join(payload, "Code"),
      spec.archivePlatform,
      actualMembersPath,
    );
    if (actualArchiveMetadata !== expectedManifest.archiveMetadataSha256)
      throw new Error(
        "Restored tree differs from its platform archive metadata",
      );
  }
  for (const path of [
    expectedManifestPath,
    actualManifestPath,
    actualMembersPath,
  ])
    unlinkSync(path);
  const stagingEntries = readdirSync(staging, { withFileTypes: true });
  if (
    stagingEntries.length !== 1 ||
    stagingEntries[0]?.name !== "payload" ||
    !stagingEntries[0].isDirectory()
  )
    throw new Error("Restore staging shape is invalid");
  protectTree(join(payload, "Code"));
  const protectedWitness = await createTreeWitness(join(payload, "Code"));
  renameSync(payload, destination);
  const finalWitness = await createTreeWitness(join(destination, "Code"));
  if (JSON.stringify(finalWitness) !== JSON.stringify(protectedWitness))
    throw new Error("Protected master changed during final placement");
  rmdirSync(staging);
  return {
    schemaVersion: 1,
    runId: spec.runId,
    snapshotId: spec.snapshotId,
    machineId: spec.machineId,
    archiveCiphertextSha256: archiveArtifact.sha256,
    archiveCiphertextBytes: archiveArtifact.size,
    manifestCiphertextSha256: manifestArtifact.sha256,
    manifestCiphertextBytes: manifestArtifact.size,
    portableSemanticSha256: expectedManifest.portableSha256,
    platformMetadataVerified,
    ignoredArchiveMetadataRecords,
    protected: true,
    witness: finalWitness,
  };
}

function sanitizedRestoreFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /^(?:Restore|Ciphertext|Semantic manifest|Encrypted|Restored|Protected|Unsupported restore platform)/u.test(
      message,
    )
  )
    return message;
  return "Encrypted restore failed without publishing path details";
}

async function extractArchive(
  archive: string,
  identity: string,
  staging: string,
  archivePlatform: EncryptedMasterRestoreSpec["archivePlatform"],
): Promise<number> {
  const payload = join(staging, "payload");
  mkdirSync(payload, { mode: 0o700 });
  const age = spawn("age", ["--decrypt", "--identity", identity, archive], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const zstd = spawn("zstd", ["--decompress", "--stdout", "--quiet"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const tarArguments = extractionArguments(payload, archivePlatform);
  const tar = spawn("tar", tarArguments, {
    env: restoreCommandEnvironment(),
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (
    age.stdout === null ||
    zstd.stdin === null ||
    zstd.stdout === null ||
    tar.stdin === null
  )
    throw new Error("Restore pipeline could not connect");
  age.stdout.pipe(zstd.stdin);
  zstd.stdout.pipe(tar.stdin);
  const ageError = collectBounded(age.stderr);
  const zstdError = collectBounded(zstd.stderr);
  const tarError = collectTarDiagnostics(tar.stderr, archivePlatform);
  const [ageStatus, zstdStatus, tarStatus] = await Promise.all([
    closeStatus(age),
    closeStatus(zstd),
    closeStatus(tar),
  ]);
  const ageDiagnostics = await ageError;
  const zstdDiagnostics = await zstdError;
  const tarDiagnostics = await tarError;
  if (
    ageStatus !== 0 ||
    zstdStatus !== 0 ||
    tarStatus !== 0 ||
    ageDiagnostics.overflow ||
    zstdDiagnostics.overflow ||
    tarDiagnostics.overflow ||
    ageDiagnostics.output.length > 0 ||
    zstdDiagnostics.output.length > 0 ||
    tarDiagnostics.output.length > 0
  )
    throw new Error("Encrypted restore pipeline failed or emitted a warning");
  return tarDiagnostics.ignoredArchiveMetadataRecords;
}

async function decryptCompressedFile(
  ciphertext: string,
  identity: string,
  output: string,
): Promise<void> {
  const descriptor = openSync(output, "wx", 0o600);
  const age = spawn("age", ["--decrypt", "--identity", identity, ciphertext], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const zstd = spawn("zstd", ["--decompress", "--stdout", "--quiet"], {
    stdio: ["pipe", descriptor, "pipe"],
  });
  closeSync(descriptor);
  if (age.stdout === null || zstd.stdin === null)
    throw new Error("Semantic manifest decrypt pipeline could not connect");
  age.stdout.pipe(zstd.stdin);
  const ageError = collectBounded(age.stderr);
  const zstdError = collectBounded(zstd.stderr);
  const [ageStatus, zstdStatus, ageDiagnostics, zstdDiagnostics] =
    await Promise.all([
      closeStatus(age),
      closeStatus(zstd),
      ageError,
      zstdError,
    ]);
  if (
    ageStatus !== 0 ||
    zstdStatus !== 0 ||
    ageDiagnostics.overflow ||
    zstdDiagnostics.overflow ||
    ageDiagnostics.output.length > 0 ||
    zstdDiagnostics.output.length > 0
  )
    throw new Error("Semantic manifest decrypt failed or emitted a warning");
}

function extractionArguments(
  payload: string,
  archivePlatform: EncryptedMasterRestoreSpec["archivePlatform"],
): string[] {
  if (process.platform === "darwin")
    return [
      "-x",
      "--acls",
      "--xattrs",
      "--fflags",
      "--no-mac-metadata",
      "-f",
      "-",
      "-C",
      payload,
      "-p",
    ];
  const arguments_ = [
    "--extract",
    "--file=-",
    `--directory=${payload}`,
    "--no-same-owner",
    "--same-permissions",
    "--delay-directory-restore",
  ];
  if (archivePlatform === "linux") arguments_.push("--acls", "--xattrs");
  return arguments_;
}

function restoreCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: "C",
    TZ: "UTC",
    ...(process.platform === "darwin" ? { COPYFILE_DISABLE: "1" } : {}),
  };
}

function currentPlatform(): EncryptedMasterRestoreSpec["archivePlatform"] {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  throw new Error(`Unsupported restore platform: ${process.platform}`);
}

function exactlyOneArtifact(
  witness: CiphertextWitness,
  predicate: (artifact: CiphertextWitness["artifacts"][number]) => boolean,
): CiphertextWitness["artifacts"][number] {
  const matches = witness.artifacts.filter(predicate);
  if (matches.length !== 1)
    throw new Error(
      "Ciphertext witness must bind one archive and one semantic manifest",
    );
  return matches[0]!;
}

function protectTree(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error("Restored master contains an unsupported object");
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) visit(join(path, entry));
    chmodSync(path, stat.mode & ~0o222);
  };
  visit(root);
}

function parseCiphertextWitness(value: unknown): CiphertextWitness {
  if (typeof value !== "object" || value === null)
    throw new Error("Ciphertext witness must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schema_version !== 1 ||
    !safeId(input.snapshot_id) ||
    !safeId(input.machine_id) ||
    !Array.isArray(input.artifacts) ||
    input.artifacts.length === 0
  )
    throw new Error("Ciphertext witness is invalid");
  for (const value of input.artifacts) {
    if (typeof value !== "object" || value === null)
      throw new Error("Ciphertext artifact witness is invalid");
    const artifact = value as Record<string, unknown>;
    if (
      typeof artifact.name !== "string" ||
      basename(artifact.name) !== artifact.name ||
      !artifact.name.endsWith(".age") ||
      !Number.isSafeInteger(artifact.size) ||
      Number(artifact.size) < 1 ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      throw new Error("Ciphertext artifact witness is invalid");
  }
  return value as CiphertextWitness;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
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

interface BoundedDiagnostics {
  readonly output: Buffer;
  readonly overflow: boolean;
}

interface TarDiagnostics extends BoundedDiagnostics {
  readonly ignoredArchiveMetadataRecords: number;
}

async function collectTarDiagnostics(
  stream: NodeJS.ReadableStream | null,
  archivePlatform: EncryptedMasterRestoreSpec["archivePlatform"],
): Promise<TarDiagnostics> {
  if (stream === null)
    return {
      output: Buffer.alloc(0),
      overflow: false,
      ignoredArchiveMetadataRecords: 0,
    };
  const unexpected: Buffer[] = [];
  let unexpectedBytes = 0;
  let overflow = false;
  let ignoredArchiveMetadataRecords = 0;
  let pending = "";
  const acceptLine = (line: string): void => {
    if (
      archivePlatform === "macos" &&
      /^tar: Ignoring unknown extended header keyword '(?:LIBARCHIVE\.(?:creationtime|xattr\.[^'\r\n]+)|SCHILY\.(?:fflags|acl\.[^'\r\n]+))'$/u.test(
        line,
      )
    ) {
      ignoredArchiveMetadataRecords += 1;
      return;
    }
    const value = Buffer.from(`${line}\n`);
    unexpectedBytes += value.length;
    if (unexpectedBytes <= 1024 * 1024) unexpected.push(value);
    else overflow = true;
  };
  for await (const chunk of stream) {
    pending += Buffer.from(chunk).toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) acceptLine(line.replace(/\r$/u, ""));
  }
  if (pending.length > 0) acceptLine(pending.replace(/\r$/u, ""));
  return {
    output: Buffer.concat(unexpected),
    overflow,
    ignoredArchiveMetadataRecords,
  };
}

function closeStatus(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  });
}

function assertContained(path: string, root: string, label: string): void {
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}${sep}`))
    throw new Error(`${label} must be below the sentinel base`);
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  );
}
