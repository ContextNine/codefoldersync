import { createHash } from "node:crypto";
import {
  createWriteStream,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  checkStorageBudget,
  inspectPhysicalTree,
  type StorageBudgetResult,
} from "./storage.js";

export type BackupArtifactKind = "archive" | "manifest";

export interface BackupReceiptSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly receiptBase: string;
  readonly sessionDirectory: string;
  readonly bundleDirectory: string;
  readonly baselineAllocatedBytes: number;
  readonly projectedBytes: number;
}

export interface BackupArtifactReceipt {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly artifact: BackupArtifactKind;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly storage: StorageBudgetResult;
  readonly received: true;
}

export interface BackupReceiptResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly snapshotId: string;
  readonly machineId: string;
  readonly artifacts: readonly {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly finalized: true;
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

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const monitorIntervalBytes = 8 * 1024 ** 2;

export function readBackupReceiptSpec(path: string): BackupReceiptSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Backup receipt spec must be an object");
  validateReceiptSpec(value as BackupReceiptSpec);
  return value as BackupReceiptSpec;
}

export async function receiveBackupArtifact(
  spec: BackupReceiptSpec,
  kind: BackupArtifactKind,
  input: Readable,
): Promise<BackupArtifactReceipt> {
  const validated = validateReceiptSpec(spec);
  prepareSession(validated);
  const name = artifactName(spec.machineId, kind);
  const destination = join(validated.sessionDirectory, name);
  const partial = `${destination}.partial`;
  const receiptPath = join(validated.sessionDirectory, `${kind}.receipt.json`);
  if (existsSync(destination) || existsSync(partial) || existsSync(receiptPath))
    throw new Error("Backup receipt artifact already exists");
  const output = createWriteStream(partial, {
    flags: "wx",
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let bytes = 0;
  let nextMonitor = monitorIntervalBytes;
  const monitor = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes >= nextMonitor) {
        try {
          checkReceiptBudget(validated, 0);
          nextMonitor = bytes + monitorIntervalBytes;
        } catch (error) {
          callback(error as Error);
          return;
        }
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, monitor, output);
    if (bytes < 1) throw new Error("Backup receipt artifact is empty");
    const storage = checkReceiptBudget(validated, 0);
    renameSync(partial, destination);
    const receipt: BackupArtifactReceipt = {
      schemaVersion: 1,
      runId: spec.runId,
      snapshotId: spec.snapshotId,
      machineId: spec.machineId,
      artifact: kind,
      name,
      size: bytes,
      sha256: hash.digest("hex"),
      storage,
      received: true,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return receipt;
  } catch (error) {
    output.destroy();
    if (existsSync(partial)) rmSync(partial, { force: true });
    throw new Error("Backup ciphertext receipt failed", { cause: error });
  }
}

export async function receiveBackupWitness(
  spec: BackupReceiptSpec,
  input: Readable,
): Promise<{ readonly accepted: true }> {
  const validated = validateReceiptSpec(spec);
  prepareSession(validated);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 1024 * 1024)
      throw new Error("Backup witness exceeds its size limit");
    chunks.push(value);
  }
  const witness = parseWitness(JSON.parse(Buffer.concat(chunks).toString()));
  if (
    witness.snapshot_id !== spec.snapshotId ||
    witness.machine_id !== spec.machineId
  )
    throw new Error("Backup witness does not match its receipt session");
  const path = join(validated.sessionDirectory, "witness.json");
  writeFileSync(path, `${JSON.stringify(witness)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  checkReceiptBudget(validated, 0);
  return { accepted: true };
}

export async function finalizeBackupReceipt(
  spec: BackupReceiptSpec,
): Promise<BackupReceiptResult> {
  const validated = validateReceiptSpec(spec);
  prepareSession(validated);
  if (existsSync(validated.bundleDirectory))
    throw new Error("Backup receipt bundle already exists");
  const witness = parseWitness(
    JSON.parse(
      readFileSync(join(validated.sessionDirectory, "witness.json"), "utf8"),
    ) as unknown,
  );
  if (
    witness.snapshot_id !== spec.snapshotId ||
    witness.machine_id !== spec.machineId ||
    witness.artifacts.length !== 2
  )
    throw new Error("Backup witness does not match its receipt session");
  for (const kind of ["archive", "manifest"] as const) {
    const receipt = parseReceipt(
      JSON.parse(
        readFileSync(
          join(validated.sessionDirectory, `${kind}.receipt.json`),
          "utf8",
        ),
      ) as unknown,
      spec,
      kind,
    );
    const artifact = witness.artifacts.find(
      (entry) => entry.name === artifactName(spec.machineId, kind),
    );
    if (
      artifact === undefined ||
      artifact.name !== receipt.name ||
      artifact.size !== receipt.size ||
      artifact.sha256 !== receipt.sha256
    )
      throw new Error("Source and receipt ciphertext witnesses differ");
    const metadata = lstatSync(join(validated.sessionDirectory, receipt.name));
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== receipt.size ||
      (await fileSha256(join(validated.sessionDirectory, receipt.name))) !==
        receipt.sha256
    )
      throw new Error("Received ciphertext artifact changed before finalize");
  }
  const expected = new Set([
    "archive.receipt.json",
    "manifest.receipt.json",
    "witness.json",
    ...witness.artifacts.map((entry) => entry.name),
  ]);
  if (
    readdirSync(validated.sessionDirectory).some((name) => !expected.has(name))
  )
    throw new Error("Backup receipt session contains an unexpected entry");
  for (const kind of ["archive", "manifest"] as const)
    unlinkSync(join(validated.sessionDirectory, `${kind}.receipt.json`));
  checkReceiptBudget(validated, 0);
  renameSync(validated.sessionDirectory, validated.bundleDirectory);
  return {
    schemaVersion: 1,
    runId: spec.runId,
    snapshotId: spec.snapshotId,
    machineId: spec.machineId,
    artifacts: witness.artifacts,
    finalized: true,
  };
}

interface ValidatedReceiptSpec extends BackupReceiptSpec {
  readonly receiptBase: string;
  readonly sessionDirectory: string;
  readonly bundleDirectory: string;
}

function validateReceiptSpec(spec: BackupReceiptSpec): ValidatedReceiptSpec {
  if (
    spec.schemaVersion !== 1 ||
    !safeId.test(spec.runId) ||
    !safeId.test(spec.snapshotId) ||
    !safeId.test(spec.machineId) ||
    !Number.isSafeInteger(spec.baselineAllocatedBytes) ||
    spec.baselineAllocatedBytes < 0 ||
    !Number.isSafeInteger(spec.projectedBytes) ||
    spec.projectedBytes < 1
  )
    throw new Error("Backup receipt spec is invalid");
  const receiptBase = resolve(spec.receiptBase);
  const sessionDirectory = resolve(spec.sessionDirectory);
  const bundleDirectory = resolve(spec.bundleDirectory);
  const baseStat = lstatSync(receiptBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error("Backup receipt base must be a physical directory");
  if (readFileSync(join(receiptBase, "SENTINEL"), "utf8") !== `${spec.runId}\n`)
    throw new Error("Backup receipt sentinel does not match the run ID");
  assertBelow(sessionDirectory, receiptBase);
  assertBelow(bundleDirectory, receiptBase);
  if (sessionDirectory === bundleDirectory)
    throw new Error("Backup receipt session and bundle must differ");
  const validated = { ...spec, receiptBase, sessionDirectory, bundleDirectory };
  checkProjectedReceiptBudget(validated);
  return validated;
}

function prepareSession(spec: ValidatedReceiptSpec): void {
  if (!existsSync(spec.sessionDirectory))
    mkdirSync(spec.sessionDirectory, { mode: 0o700 });
  const stat = lstatSync(spec.sessionDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Backup receipt session must be a physical directory");
}

function checkReceiptBudget(
  spec: ValidatedReceiptSpec,
  projectedAdditionalBytes: number,
): StorageBudgetResult {
  return checkStorageBudget({
    profile: "wootbook-acceptance",
    inventory: inspectPhysicalTree(spec.receiptBase),
    baselineAllocatedBytes: spec.baselineAllocatedBytes,
    projectedAdditionalBytes,
  });
}

function checkProjectedReceiptBudget(
  spec: ValidatedReceiptSpec,
): StorageBudgetResult {
  const inventory = inspectPhysicalTree(spec.receiptBase);
  const currentIncremental = Math.max(
    0,
    inventory.allocatedBytes - spec.baselineAllocatedBytes,
  );
  return checkStorageBudget({
    profile: "wootbook-acceptance",
    inventory,
    baselineAllocatedBytes: spec.baselineAllocatedBytes,
    projectedAdditionalBytes: Math.max(
      0,
      spec.projectedBytes - currentIncremental,
    ),
  });
}

function artifactName(machineId: string, kind: BackupArtifactKind): string {
  return kind === "archive"
    ? `${machineId}-Code.tar.zst.age`
    : `${machineId}-manifest.ndjson.zst.age`;
}

function parseWitness(value: unknown): CiphertextWitness {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Backup witness is invalid");
  const input = value as Record<string, unknown>;
  if (
    input.schema_version !== 1 ||
    typeof input.snapshot_id !== "string" ||
    !safeId.test(input.snapshot_id) ||
    typeof input.machine_id !== "string" ||
    !safeId.test(input.machine_id) ||
    !Array.isArray(input.artifacts) ||
    input.artifacts.length !== 2
  )
    throw new Error("Backup witness is invalid");
  const names = new Set<string>();
  for (const entry of input.artifacts) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("Backup witness artifact is invalid");
    const artifact = entry as Record<string, unknown>;
    if (
      typeof artifact.name !== "string" ||
      basename(artifact.name) !== artifact.name ||
      !artifact.name.endsWith(".age") ||
      names.has(artifact.name) ||
      !Number.isSafeInteger(artifact.size) ||
      Number(artifact.size) < 1 ||
      typeof artifact.sha256 !== "string" ||
      !sha256.test(artifact.sha256)
    )
      throw new Error("Backup witness artifact is invalid");
    names.add(artifact.name);
  }
  return value as CiphertextWitness;
}

function parseReceipt(
  value: unknown,
  spec: BackupReceiptSpec,
  kind: BackupArtifactKind,
): BackupArtifactReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Backup artifact receipt is invalid");
  const input = value as Partial<BackupArtifactReceipt>;
  if (
    input.schemaVersion !== 1 ||
    input.runId !== spec.runId ||
    input.snapshotId !== spec.snapshotId ||
    input.machineId !== spec.machineId ||
    input.artifact !== kind ||
    input.name !== artifactName(spec.machineId, kind) ||
    !Number.isSafeInteger(input.size) ||
    Number(input.size) < 1 ||
    typeof input.sha256 !== "string" ||
    !sha256.test(input.sha256) ||
    input.received !== true
  )
    throw new Error("Backup artifact receipt is invalid");
  return value as BackupArtifactReceipt;
}

function assertBelow(path: string, root: string): void {
  if (!path.startsWith(`${root}${sep}`))
    throw new Error("Backup receipt path escapes its sentinel base");
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
