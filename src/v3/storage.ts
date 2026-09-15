import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const gibibyte = 1024 ** 3;

export const storageLimits = {
  macTransientBytes: 5 * gibibyte,
  wootbookTargetBytes: 150 * gibibyte,
  wootbookHardBytes: 200 * gibibyte,
  boundedCorpusBytes: 25 * gibibyte,
} as const;

export type StorageProfile =
  "mac-transient" | "wootbook-acceptance" | "bounded-corpus";

export interface PhysicalTreeInventory {
  readonly schemaVersion: 1;
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly symlinks: number;
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
  readonly availableBytes: number;
  readonly filesystemDevice: string;
}

export interface StorageBudgetResult {
  readonly schemaVersion: 1;
  readonly profile: StorageProfile;
  readonly currentAllocatedBytes: number;
  readonly baselineAllocatedBytes: number;
  readonly incrementalAllocatedBytes: number;
  readonly projectedAdditionalBytes: number;
  readonly projectedIncrementalBytes: number;
  readonly targetBytes: number;
  readonly hardLimitBytes: number;
  readonly availableBytes: number;
  readonly passed: true;
}

export interface CleanupRunSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runRoot: string;
}

export interface CleanupRunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly removedAllocatedBytes: number;
  readonly removed: true;
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Inventories physical allocation without following symlinks or crossing a
 * filesystem boundary. Hard-linked regular files are counted once.
 */
export function inspectPhysicalTree(rootInput: string): PhysicalTreeInventory {
  const root = resolve(rootInput);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Inventory root must be a physical directory");
  const device = rootStat.dev;
  const seen = new Set<string>();
  let entries = 0;
  let directories = 0;
  let files = 0;
  let symlinks = 0;
  let logicalBytes = 0n;
  let allocatedBytes = 0n;

  const visit = (path: string): void => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.dev !== device)
      throw new Error("Physical inventory refuses to cross a nested mount");
    entries += 1;
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      logicalBytes += stat.size;
      allocatedBytes += allocatedSize(stat);
      return;
    }
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error("Physical inventory found an unsupported object");
    const identity = `${stat.dev}:${stat.ino}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      logicalBytes += stat.size;
      allocatedBytes += allocatedSize(stat);
    }
    if (stat.isFile()) {
      files += 1;
      return;
    }
    directories += 1;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
    ))
      visit(join(path, entry.name));
  };

  visit(root);
  const filesystem = statfsSync(root, { bigint: true });
  return {
    schemaVersion: 1,
    entries,
    directories,
    files,
    symlinks,
    logicalBytes: safeNumber(logicalBytes, "logical bytes"),
    allocatedBytes: safeNumber(allocatedBytes, "allocated bytes"),
    availableBytes: safeNumber(
      filesystem.bavail * filesystem.bsize,
      "available bytes",
    ),
    filesystemDevice: device.toString(),
  };
}

export function checkStorageBudget(input: {
  readonly profile: StorageProfile;
  readonly inventory: PhysicalTreeInventory;
  readonly baselineAllocatedBytes: number;
  readonly projectedAdditionalBytes: number;
  readonly allowAboveTarget?: boolean;
}): StorageBudgetResult {
  const { targetBytes, hardLimitBytes } = profileLimits(input.profile);
  for (const [label, value] of [
    ["baseline allocated bytes", input.baselineAllocatedBytes],
    ["projected additional bytes", input.projectedAdditionalBytes],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid ${label}`);
  const incrementalAllocatedBytes = Math.max(
    0,
    input.inventory.allocatedBytes - input.baselineAllocatedBytes,
  );
  const projectedIncrementalBytes =
    incrementalAllocatedBytes + input.projectedAdditionalBytes;
  if (projectedIncrementalBytes > hardLimitBytes)
    throw new Error("Projected allocation exceeds the hard storage limit");
  if (
    projectedIncrementalBytes > targetBytes &&
    input.allowAboveTarget !== true
  )
    throw new Error("Projected allocation exceeds the normal storage target");
  if (input.projectedAdditionalBytes > input.inventory.availableBytes)
    throw new Error("Filesystem lacks the projected available capacity");
  return {
    schemaVersion: 1,
    profile: input.profile,
    currentAllocatedBytes: input.inventory.allocatedBytes,
    baselineAllocatedBytes: input.baselineAllocatedBytes,
    incrementalAllocatedBytes,
    projectedAdditionalBytes: input.projectedAdditionalBytes,
    projectedIncrementalBytes,
    targetBytes,
    hardLimitBytes,
    availableBytes: input.inventory.availableBytes,
    passed: true,
  };
}

export function estimateSourceCaptureTransientBytes(
  inventory: PhysicalTreeInventory,
): number {
  return checkedProjection(
    inventory.entries * 4096 + 64 * 1024 ** 2,
    "source capture transient bytes",
  );
}

export function estimateCiphertextReceiptBytes(
  inventory: PhysicalTreeInventory,
): number {
  return checkedProjection(
    Math.ceil(inventory.logicalBytes * 1.02) + 64 * 1024 ** 2,
    "ciphertext receipt bytes",
  );
}

export function estimateRestoreSlotBytes(input: {
  readonly ciphertextBytes: number;
  readonly restoredTree: PhysicalTreeInventory;
}): number {
  if (!Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 0)
    throw new Error("Invalid ciphertext bytes");
  return checkedProjection(
    input.ciphertextBytes +
      Math.max(
        input.restoredTree.logicalBytes,
        input.restoredTree.allocatedBytes,
      ) +
      64 * 1024 ** 2,
    "restore slot bytes",
  );
}

export function readCleanupRunSpec(path: string): CleanupRunSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Cleanup spec must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.runId !== "string" ||
    !safeId.test(input.runId) ||
    typeof input.runRoot !== "string"
  )
    throw new Error("Cleanup spec is invalid");
  return value as CleanupRunSpec;
}

/** Removes exactly one sentinel-qualified disposable run root. */
export function cleanupRunRoot(spec: CleanupRunSpec): CleanupRunResult {
  if (spec.schemaVersion !== 1 || !safeId.test(spec.runId))
    throw new Error("Cleanup spec is invalid");
  const root = resolve(spec.runRoot);
  assertDisposableRoot(root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Cleanup root must be a physical directory");
  if (readFileSync(join(root, "SENTINEL"), "utf8") !== `${spec.runId}\n`)
    throw new Error("Cleanup sentinel does not match the run ID");
  const before = inspectPhysicalTree(root);
  try {
    makeOwnerWritable(root);
    rmSync(root, { recursive: true, force: false });
  } catch {
    clearProtection(root);
    makeOwnerWritable(root);
    try {
      rmSync(root, { recursive: true, force: false });
    } catch (error) {
      throw new Error("Acceptance cleanup could not remove its run root", {
        cause: error,
      });
    }
  }
  if (existsSync(root)) throw new Error("Acceptance cleanup left its run root");
  return {
    schemaVersion: 1,
    runId: spec.runId,
    removedAllocatedBytes: before.allocatedBytes,
    removed: true,
  };
}

function profileLimits(profile: StorageProfile): {
  readonly targetBytes: number;
  readonly hardLimitBytes: number;
} {
  switch (profile) {
    case "mac-transient":
      return {
        targetBytes: storageLimits.macTransientBytes,
        hardLimitBytes: storageLimits.macTransientBytes,
      };
    case "wootbook-acceptance":
      return {
        targetBytes: storageLimits.wootbookTargetBytes,
        hardLimitBytes: storageLimits.wootbookHardBytes,
      };
    case "bounded-corpus":
      return {
        targetBytes: storageLimits.boundedCorpusBytes,
        hardLimitBytes: storageLimits.boundedCorpusBytes,
      };
  }
}

function allocatedSize(stat: {
  readonly blocks: bigint;
  readonly size: bigint;
}): bigint {
  return stat.blocks > 0n ? stat.blocks * 512n : stat.size;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} exceeds the safe integer range`);
  return Number(value);
}

function checkedProjection(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} exceeds the safe integer range`);
  return value;
}

function assertDisposableRoot(root: string): void {
  if (!isAbsolute(root) || root === sep || dirname(root) === sep)
    throw new Error("Cleanup root is too broad");
  const name = basename(root);
  if (name.length < 8 || name === "Code" || name.startsWith("."))
    throw new Error("Cleanup root is not a run-qualified directory");
}

function clearProtection(root: string): void {
  if (process.platform === "darwin") {
    requireCleanupCommand("chflags", ["-R", "nouchg,noschg", root]);
    requireCleanupCommand("chmod", ["-RN", root]);
  } else if (process.platform === "linux") {
    bestEffortCleanupCommand("chattr", ["-R", "-i", "-a", root]);
    bestEffortCleanupCommand("setfacl", ["-Rb", root]);
  }
}

function makeOwnerWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory() && !stat.isFile())
    throw new Error("Cleanup found an unsupported filesystem object");
  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory())
    for (const entry of readdirSync(path)) makeOwnerWritable(join(path, entry));
}

function requireCleanupCommand(command: string, arguments_: string[]): void {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error("Acceptance cleanup could not clear filesystem protection");
}

function bestEffortCleanupCommand(command: string, arguments_: string[]): void {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Acceptance cleanup tool failed");
  }
}
