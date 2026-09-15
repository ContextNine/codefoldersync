import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../v2/hash.js";
import { createTreeWitness, type TreeWitness } from "./acceptance.js";
import {
  checkStorageBudget,
  inspectPhysicalTree,
  storageLimits,
  type PhysicalTreeInventory,
} from "./storage.js";

export interface BoundedCorpusSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly seed: string;
  readonly outputBase: string;
  readonly corpusRoot: string;
  readonly shape: {
    readonly directories: number;
    readonly files: number;
    readonly symlinks: number;
    readonly executableFiles: number;
    readonly gitRepositories: number;
    readonly maxDepth: number;
    readonly payloadBytes: number;
  };
}

export interface BoundedCorpusResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly shapeSha256: string;
  readonly inventory: PhysicalTreeInventory;
  readonly witness: TreeWitness;
  readonly passed: true;
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const maximumEntries = 1_000_000;

export function readBoundedCorpusSpec(path: string): BoundedCorpusSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Bounded corpus spec must be an object");
  validateSpec(value as BoundedCorpusSpec);
  return value as BoundedCorpusSpec;
}

export async function generateBoundedCorpus(
  spec: BoundedCorpusSpec,
): Promise<BoundedCorpusResult> {
  const validated = validateSpec(spec);
  const baseline = inspectPhysicalTree(validated.outputBase).allocatedBytes;
  checkStorageBudget({
    profile: "bounded-corpus",
    inventory: inspectPhysicalTree(validated.outputBase),
    baselineAllocatedBytes: baseline,
    projectedAdditionalBytes: spec.shape.payloadBytes,
  });
  mkdirSync(validated.corpusRoot, { mode: 0o700 });
  let complete = false;
  try {
    const directories = createDirectories(spec, validated.corpusRoot);
    createFiles(spec, directories, validated.outputBase, baseline);
    createSymlinks(spec, directories);
    createGitRepositories(spec, directories);
    const inventory = inspectPhysicalTree(validated.corpusRoot);
    checkStorageBudget({
      profile: "bounded-corpus",
      inventory: inspectPhysicalTree(validated.outputBase),
      baselineAllocatedBytes: baseline,
      projectedAdditionalBytes: 0,
    });
    const witness = await createTreeWitness(validated.corpusRoot);
    complete = true;
    return {
      schemaVersion: 1,
      runId: spec.runId,
      shapeSha256: createHash("sha256")
        .update(canonicalJson(spec.shape))
        .digest("hex"),
      inventory,
      witness,
      passed: true,
    };
  } finally {
    if (!complete && existsSync(validated.corpusRoot))
      rmSync(validated.corpusRoot, { recursive: true, force: false });
  }
}

interface ValidatedSpec extends BoundedCorpusSpec {
  readonly outputBase: string;
  readonly corpusRoot: string;
}

function validateSpec(spec: BoundedCorpusSpec): ValidatedSpec {
  const shape = spec.shape;
  if (
    spec.schemaVersion !== 1 ||
    !safeId.test(spec.runId) ||
    typeof spec.seed !== "string" ||
    spec.seed.length < 1 ||
    spec.seed.length > 256 ||
    typeof shape !== "object" ||
    shape === null
  )
    throw new Error("Bounded corpus spec is invalid");
  for (const value of [
    shape.directories,
    shape.files,
    shape.symlinks,
    shape.executableFiles,
    shape.gitRepositories,
    shape.maxDepth,
    shape.payloadBytes,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Bounded corpus shape is invalid");
  if (
    shape.directories < 1 ||
    shape.files < 1 ||
    shape.directories + shape.files + shape.symlinks > maximumEntries ||
    shape.executableFiles > shape.files ||
    shape.gitRepositories > shape.directories ||
    shape.maxDepth < 1 ||
    shape.maxDepth > 64 ||
    shape.payloadBytes > storageLimits.boundedCorpusBytes
  )
    throw new Error("Bounded corpus shape exceeds its fixed limits");
  const outputBase = resolve(spec.outputBase);
  const corpusRoot = resolve(spec.corpusRoot);
  const baseStat = lstatSync(outputBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error("Bounded corpus base must be a physical directory");
  if (readFileSync(join(outputBase, "SENTINEL"), "utf8") !== `${spec.runId}\n`)
    throw new Error("Bounded corpus sentinel does not match the run ID");
  if (
    !corpusRoot.startsWith(`${outputBase}${sep}`) ||
    basename(corpusRoot) !== "Code"
  )
    throw new Error("Bounded corpus root must be a contained Code directory");
  if (existsSync(corpusRoot)) throw new Error("Bounded corpus root exists");
  return { ...spec, outputBase, corpusRoot };
}

function createDirectories(
  spec: BoundedCorpusSpec,
  corpusRoot: string,
): { readonly path: string; readonly depth: number }[] {
  const directories = [{ path: corpusRoot, depth: 0 }];
  for (let index = 1; index < spec.shape.directories; index += 1) {
    const eligible = directories.filter(
      (entry) => entry.depth < spec.shape.maxDepth,
    );
    const parent =
      eligible[pick(spec.seed, `directory-${index}`, eligible.length)]!;
    const path = join(
      parent.path,
      `directory-${index.toString().padStart(6, "0")}`,
    );
    mkdirSync(path, { mode: 0o700 });
    directories.push({ path, depth: parent.depth + 1 });
  }
  return directories;
}

function createFiles(
  spec: BoundedCorpusSpec,
  directories: readonly { readonly path: string }[],
  outputBase: string,
  baselineAllocatedBytes: number,
): void {
  const baseSize = Math.floor(spec.shape.payloadBytes / spec.shape.files);
  const remainder = spec.shape.payloadBytes % spec.shape.files;
  for (let index = 0; index < spec.shape.files; index += 1) {
    const parent =
      directories[pick(spec.seed, `file-${index}`, directories.length)]!;
    const path = join(
      parent.path,
      `file-${index.toString().padStart(7, "0")}.bin`,
    );
    const size = baseSize + (index < remainder ? 1 : 0);
    writeDeterministicFile(path, size, `${spec.seed}:file:${index}`);
    if (index < spec.shape.executableFiles) chmodSync(path, 0o700);
    if (index % 64 === 0)
      checkStorageBudget({
        profile: "bounded-corpus",
        inventory: inspectPhysicalTree(outputBase),
        baselineAllocatedBytes,
        projectedAdditionalBytes: 0,
      });
  }
}

function createSymlinks(
  spec: BoundedCorpusSpec,
  directories: readonly { readonly path: string }[],
): void {
  for (let index = 0; index < spec.shape.symlinks; index += 1) {
    const parent =
      directories[pick(spec.seed, `symlink-${index}`, directories.length)]!;
    symlinkSync(
      `missing-${index}`,
      join(parent.path, `symlink-${index.toString().padStart(6, "0")}`),
    );
  }
}

function createGitRepositories(
  spec: BoundedCorpusSpec,
  directories: readonly { readonly path: string }[],
): void {
  const selected = directories
    .map((entry) => entry.path)
    .sort((left, right) =>
      relative(spec.corpusRoot, left).localeCompare(
        relative(spec.corpusRoot, right),
        "en",
      ),
    )
    .slice(0, spec.shape.gitRepositories);
  for (const repository of selected) {
    runGit(repository, ["init", "-q"]);
    runGit(repository, ["config", "user.name", "CodeFolderSync Fixture"]);
    runGit(repository, [
      "config",
      "user.email",
      "fixture@codefoldersync.invalid",
    ]);
    runGit(repository, ["add", "-A"]);
    runGit(repository, ["commit", "-qm", "fixture", "--allow-empty"]);
  }
}

function writeDeterministicFile(
  path: string,
  size: number,
  seed: string,
): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const digest = createHash("sha256").update(seed).digest();
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
    for (let index = 0; index < chunk.length; index += 1)
      chunk[index] = digest[index % digest.length]!;
    let remaining = size;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      writeSync(descriptor, chunk, 0, length);
      remaining -= length;
    }
  } finally {
    closeSync(descriptor);
  }
}

function pick(seed: string, label: string, maximum: number): number {
  if (maximum < 1) throw new Error("Bounded corpus has no placement target");
  return (
    createHash("sha256").update(`${seed}:${label}`).digest().readUInt32BE(0) %
    maximum
  );
}

function runGit(repository: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.stderr.length > 0)
    throw new Error("Bounded corpus Git fixture failed");
}
