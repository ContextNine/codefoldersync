import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson, hashText } from "../v2/hash.js";
import { scanNamespace } from "./catalog.js";
import {
  applyDistributedTargetV3,
  prepareDistributedSetupV3,
  type DistributedFleetSpec,
} from "./distributed.js";
import { ProcessDistributedExecutor } from "./distributed-process.js";
import { cutoverAdoptionV3, syncFolderV3, verifyFullV3 } from "./engine.js";
import { activatePeerV3, readEnrollmentRequest } from "./setup.js";
import { ensureIgnore, loadConfig } from "./config.js";
import { compileIgnore, defaultIgnore } from "./ignore.js";
import { ObjectStore } from "./objects.js";
import { LocalState } from "./state.js";
import type { ProductConfig } from "./types.js";

export interface TreeWitness {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly symlinks: number;
  readonly bytes: number;
}

export interface PseudoFleetMasterSpec {
  readonly machineId: string;
  readonly root: string;
  readonly witness: TreeWitness;
}

export interface PseudoFleetAcceptanceSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly repetitions: 2;
  readonly runRoot: string;
  readonly expectedVersion: string;
  readonly expectedReleaseSha256: string;
  readonly command: readonly string[];
  readonly backupWitness: string;
  readonly sourceMachineId: string;
  readonly targetOrder: readonly string[];
  readonly hubMachineId: string;
  readonly masters: readonly PseudoFleetMasterSpec[];
}

export interface PseudoFleetRunResult {
  readonly repetition: number;
  readonly sourceDigest: string;
  readonly targetDigests: Readonly<Record<string, string>>;
  readonly workload: {
    readonly files: number;
    readonly directories: number;
    readonly bytes: number;
    readonly cassetteDigest: string;
    readonly sourcePublishMs: number;
    readonly allTargetsConvergedMs: number;
  };
  readonly conflicts: number;
  readonly passed: true;
}

export interface PseudoFleetCapacityEstimate {
  readonly schemaVersion: 1;
  readonly repetitions: 2;
  readonly workspaceBytesPerRepetition: number;
  readonly includedBytesPerRepetition: number;
  readonly targetRecoveryBytesPerRepetition: number;
  readonly objectStoreCopiesPerRepetition: number;
  readonly projectedBytesPerRepetition: number;
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly reserveFactor: 1.25;
  readonly passed: boolean;
}

export function readPseudoFleetAcceptanceSpec(
  path: string,
): PseudoFleetAcceptanceSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  assertPseudoFleetSpec(value);
  return value;
}

export async function createTreeWitness(root: string): Promise<TreeWitness> {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory())
    throw new Error("Witness root must be a directory");
  const digest = createHash("sha256");
  let entries = 0;
  let directories = 0;
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  const appendRecord = (record: string): void => {
    if (entries > 0) digest.update("\n");
    digest.update(record);
    entries += 1;
  };
  const visit = async (directory: string): Promise<void> => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.dev !== rootStat.dev)
        throw new Error("Tree witness refuses to cross a nested mount");
      const local = relative(absoluteRoot, path).split(sep).join("/");
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        directories += 1;
        appendRecord(canonicalJson([local, "directory", mode]));
        await visit(path);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        appendRecord(
          canonicalJson([
            local,
            "regular",
            mode,
            stat.size,
            await fileDigest(path),
          ]),
        );
      } else if (stat.isSymbolicLink()) {
        symlinks += 1;
        appendRecord(
          canonicalJson([local, "symlink", mode, readlinkSync(path)]),
        );
      } else {
        throw new Error("Tree witness found an unsupported filesystem object");
      }
    }
  };
  await visit(absoluteRoot);
  return {
    schemaVersion: 1,
    digest: digest.digest("hex"),
    entries,
    directories,
    files,
    symlinks,
    bytes,
  };
}

/** Acceptance copies are disposable workspaces; protected masters stay read-only. */
export function makeTreeOwnerWritable(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile())
      throw new Error("Acceptance copy contains an unsupported object");
    chmodSync(path, stat.mode | 0o200);
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(resolve(root));
}

export async function runPseudoFleetAcceptanceV3(
  spec: PseudoFleetAcceptanceSpec,
): Promise<readonly PseudoFleetRunResult[]> {
  validatePseudoFleetSpec(spec);
  assertSentinel(spec.runRoot, spec.runId);
  const capacity = estimatePseudoFleetCapacityV3(spec);
  if (!capacity.passed)
    throw new Error(
      `Pseudo-fleet lacks its two-run copy, object, recovery, and 25 percent reserve: required ${capacity.requiredBytes}, available ${capacity.availableBytes}`,
    );
  for (const master of spec.masters) {
    const witness = await createTreeWitness(master.root);
    if (canonicalJson(witness) !== canonicalJson(master.witness))
      throw new Error(`Master witness mismatch: ${master.machineId}`);
  }
  const results: PseudoFleetRunResult[] = [];
  for (let repetition = 1; repetition <= spec.repetitions; repetition += 1)
    results.push(await runPseudoFleetRepetition(spec, repetition));
  for (const master of spec.masters) {
    const witness = await createTreeWitness(master.root);
    if (canonicalJson(witness) !== canonicalJson(master.witness))
      throw new Error(`Master changed during acceptance: ${master.machineId}`);
  }
  return results;
}

export function estimatePseudoFleetCapacityV3(
  spec: PseudoFleetAcceptanceSpec,
): PseudoFleetCapacityEstimate {
  validatePseudoFleetSpec(spec);
  assertSentinel(spec.runRoot, spec.runId);
  const workspaceBytesPerRepetition = spec.masters.reduce(
    (total, master) => total + master.witness.bytes,
    0,
  );
  const includedByMachine = new Map(
    spec.masters.map((master) => [
      master.machineId,
      includedLogicalBytes(master.root),
    ]),
  );
  const includedBytesPerRepetition = [...includedByMachine.values()].reduce(
    (total, bytes) => total + bytes,
    0,
  );
  const targetRecoveryBytesPerRepetition = spec.targetOrder.reduce(
    (total, machineId) =>
      total + requiredCapacity(includedByMachine, machineId),
    0,
  );
  const objectStoreCopiesPerRepetition = spec.masters.length + 1;
  const projectedBytesPerRepetition =
    workspaceBytesPerRepetition +
    includedBytesPerRepetition * objectStoreCopiesPerRepetition +
    targetRecoveryBytesPerRepetition;
  const reserveFactor = 1.25 as const;
  const requiredBytes = Math.ceil(
    projectedBytesPerRepetition * spec.repetitions * reserveFactor,
  );
  const filesystem = statfsSync(resolve(spec.runRoot));
  const availableBytes = filesystem.bavail * filesystem.bsize;
  return {
    schemaVersion: 1,
    repetitions: 2,
    workspaceBytesPerRepetition,
    includedBytesPerRepetition,
    targetRecoveryBytesPerRepetition,
    objectStoreCopiesPerRepetition,
    projectedBytesPerRepetition,
    requiredBytes,
    availableBytes,
    reserveFactor,
    passed: availableBytes >= requiredBytes,
  };
}

async function runPseudoFleetRepetition(
  spec: PseudoFleetAcceptanceSpec,
  repetition: number,
): Promise<PseudoFleetRunResult> {
  const repetitionRoot = join(
    resolve(spec.runRoot),
    `${spec.scenarioId}-${String(repetition).padStart(2, "0")}`,
  );
  if (existsSync(repetitionRoot))
    throw new Error(`Acceptance repetition already exists: ${repetition}`);
  mkdirSync(repetitionRoot, { recursive: false, mode: 0o700 });
  writeFileSync(
    join(repetitionRoot, "SENTINEL"),
    `${spec.runId}:${repetition}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
  const roots: Record<string, string> = {};
  for (const master of spec.masters) {
    const peerRoot = join(repetitionRoot, "peers", master.machineId, "Code");
    copyTree(master.root, peerRoot);
    roots[master.machineId] = peerRoot;
  }
  const authorityRoot = requiredRoot(roots, spec.sourceMachineId);
  const machine = (machineId: string): DistributedFleetSpec["authority"] => ({
    machineId,
    peerName: machineId,
    endpoint: { kind: "local" },
    command: spec.command,
    root: requiredRoot(roots, machineId),
    stateDir: join(repetitionRoot, "peers", machineId, "state"),
    configPath: join(
      requiredRoot(roots, machineId),
      ".codefoldersync",
      "config.json",
    ),
  });
  const distributed: DistributedFleetSpec = {
    schemaVersion: 1,
    runId: `${spec.runId}-${repetition}`,
    expectedVersion: spec.expectedVersion,
    expectedReleaseSha256: spec.expectedReleaseSha256,
    folderName: spec.scenarioId,
    backupWitness: spec.backupWitness,
    controllerStateDir: join(repetitionRoot, "controller"),
    hub: { kind: "local", path: join(repetitionRoot, "hub") },
    authority: machine(spec.sourceMachineId),
    targets: spec.targetOrder.map((machineId) => ({
      ...machine(machineId),
      role: machineId === spec.hubMachineId ? "hub" : "peer",
      requestPath: join(repetitionRoot, "peers", machineId, "request.json"),
    })),
  };
  const executor = new ProcessDistributedExecutor();
  const prepared = await prepareDistributedSetupV3(distributed, executor);
  for (const target of prepared.targets) {
    if (target.adoptionId === null)
      throw new Error(
        `Acceptance target has no adoption plan: ${target.machineId}`,
      );
    await applyDistributedTargetV3(
      distributed,
      executor,
      target.machineId,
      target.adoptionId,
    );
  }

  const authorityPath = distributed.authority.configPath;
  const authority = await cutoverAdoptionV3(
    loadConfig(authorityPath),
    authorityPath,
  );
  for (const target of distributed.targets)
    activatePeerV3({
      acceptedConfig: authority,
      request: readEnrollmentRequest(target.requestPath),
      stateDir: target.stateDir,
      configPath: target.configPath,
    });

  const workloadStarted = performance.now();
  const workload = writeDeterministicWorkload(authorityRoot, spec.seed);
  const publishStarted = performance.now();
  const sourceSummary = await syncFolderV3(loadConfig(authorityPath));
  if (sourceSummary.status !== "clean" && sourceSummary.status !== "conflict")
    throw new Error("Pseudo-fleet source publication failed");
  const sourcePublishMs = performance.now() - publishStarted;
  for (const target of distributed.targets) {
    const summary = await syncFolderV3(loadConfig(target.configPath));
    if (summary.status !== "clean" && summary.status !== "conflict")
      throw new Error(`Pseudo-fleet target sync failed: ${target.machineId}`);
  }
  const allTargetsConvergedMs = performance.now() - workloadStarted;
  const sourceVerification = await verifyFullV3(loadConfig(authorityPath));
  if (
    sourceVerification.status !== "clean" &&
    sourceVerification.status !== "conflict"
  )
    throw new Error("Pseudo-fleet source verification failed");
  const targetDigests: Record<string, string> = {};
  const sourceDigest = productDigest(loadConfig(authorityPath));
  let conflicts = sourceVerification.conflicts;
  for (const target of distributed.targets) {
    const targetConfig = loadConfig(target.configPath);
    const verification = await verifyFullV3(targetConfig);
    const targetDigest = productDigest(targetConfig);
    if (targetDigest !== sourceDigest)
      throw new Error(`Pseudo-fleet digest mismatch: ${target.machineId}`);
    targetDigests[target.machineId] = targetDigest;
    conflicts += verification.conflicts;
  }
  const result: PseudoFleetRunResult = {
    repetition,
    sourceDigest,
    targetDigests,
    workload: {
      ...workload,
      sourcePublishMs: milliseconds(sourcePublishMs),
      allTargetsConvergedMs: milliseconds(allTargetsConvergedMs),
    },
    conflicts,
    passed: true,
  };
  writeResult(repetitionRoot, result);
  return result;
}

function writeDeterministicWorkload(
  root: string,
  seed: string,
): {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly cassetteDigest: string;
} {
  const operations: { readonly path: string; readonly digest: string }[] = [];
  let bytes = 0;
  for (let directory = 0; directory < 8; directory += 1) {
    const path = join(
      root,
      "codefoldersync-acceptance-workload",
      `module-${directory}`,
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (let file = 0; file < 8; file += 1) {
      const local = `codefoldersync-acceptance-workload/module-${directory}/file-${file}.ts`;
      const content = `export const value${directory}_${file} = ${JSON.stringify(hashText(`${seed}:${local}`))};\n`;
      writeFileSync(join(root, ...local.split("/")), content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      bytes += Buffer.byteLength(content);
      operations.push({ path: local, digest: hashText(content) });
    }
  }
  return {
    files: operations.length,
    directories: 8,
    bytes,
    cassetteDigest: hashText(canonicalJson(operations)),
  };
}

function copyTree(source: string, destination: string): void {
  if (existsSync(destination))
    throw new Error("Acceptance copy destination exists");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    "cp",
    ["-a", "--reflink=auto", `${resolve(source)}/.`, destination],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error("Acceptance master copy failed");
  makeTreeOwnerWritable(destination);
}

export function includedLogicalBytes(root: string): number {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  const ignorePath = join(absoluteRoot, ".codefoldersyncignore");
  const ignore = compileIgnore(
    existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : defaultIgnore,
  );
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.dev !== rootStat.dev)
        throw new Error("Acceptance capacity refuses a nested mount");
      const local = relative(absoluteRoot, path).split(sep).join("/");
      if (ignore.ignores(local, stat.isDirectory())) continue;
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) bytes += stat.size;
      else if (stat.isSymbolicLink())
        bytes += Buffer.byteLength(readlinkSync(path), "utf8");
      else throw new Error("Acceptance capacity found an unsupported object");
    }
  };
  visit(absoluteRoot);
  return bytes;
}

function requiredCapacity(
  values: ReadonlyMap<string, number>,
  machineId: string,
): number {
  const value = values.get(machineId);
  if (value === undefined)
    throw new Error(`Pseudo-fleet capacity is missing: ${machineId}`);
  return value;
}

function assertSentinel(runRoot: string, runId: string): void {
  const root = resolve(runRoot);
  if (!isAbsolute(runRoot) || !existsSync(root))
    throw new Error(
      "Acceptance run root must be an existing absolute directory",
    );
  const sentinel = join(root, "SENTINEL");
  if (!existsSync(sentinel) || readFileSync(sentinel, "utf8") !== `${runId}\n`)
    throw new Error("Acceptance run sentinel does not match the run ID");
}

function requiredRoot(
  roots: Readonly<Record<string, string>>,
  machineId: string,
): string {
  const root = roots[machineId];
  if (root === undefined)
    throw new Error(`Acceptance master is missing: ${machineId}`);
  return root;
}

function writeResult(root: string, result: PseudoFleetRunResult): void {
  const evidence = join(root, "evidence");
  mkdirSync(evidence, { recursive: false, mode: 0o700 });
  const path = join(evidence, "result.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function productDigest(config: ProductConfig): string {
  using state = new LocalState(config);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  return scanNamespace(
    config,
    objects,
    ensureIgnore(config.root),
    state.catalog(),
    true,
    true,
  ).manifest.digest;
}

function milliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function assertPseudoFleetSpec(
  value: unknown,
): asserts value is PseudoFleetAcceptanceSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Pseudo-fleet specification must be an object");
  validatePseudoFleetSpec(value as PseudoFleetAcceptanceSpec);
}

function validatePseudoFleetSpec(spec: PseudoFleetAcceptanceSpec): void {
  if (spec.schemaVersion !== 1 || spec.repetitions !== 2)
    throw new Error(
      "Pseudo-fleet acceptance requires schema 1 and two repetitions",
    );
  for (const [name, value] of [
    ["runId", spec.runId],
    ["scenarioId", spec.scenarioId],
    ["seed", spec.seed],
    ["expectedVersion", spec.expectedVersion],
    ["backupWitness", spec.backupWitness],
  ] as const)
    if (value.trim().length === 0)
      throw new Error(`Pseudo-fleet ${name} is empty`);
  if (!isAbsolute(spec.runRoot))
    throw new Error("Pseudo-fleet run root must be absolute");
  if (!/^[a-f0-9]{64}$/u.test(spec.expectedReleaseSha256))
    throw new Error("Pseudo-fleet release SHA-256 is invalid");
  if (spec.command.length === 0)
    throw new Error("Pseudo-fleet CodeFolderSync command is missing");
  const ids = spec.masters.map((master) => master.machineId);
  if (new Set(ids).size !== ids.length || ids.length < 3)
    throw new Error("Pseudo-fleet requires distinct source and target masters");
  if (!ids.includes(spec.sourceMachineId))
    throw new Error("Pseudo-fleet source master is missing");
  if (!ids.includes(spec.hubMachineId))
    throw new Error("Pseudo-fleet hub master is missing");
  if (
    spec.targetOrder.length !== ids.length - 1 ||
    spec.targetOrder.includes(spec.sourceMachineId) ||
    spec.targetOrder.some((machineId) => !ids.includes(machineId))
  )
    throw new Error("Pseudo-fleet target order is invalid");
  for (const master of spec.masters) {
    if (!isAbsolute(master.root))
      throw new Error(
        `Pseudo-fleet master root must be absolute: ${master.machineId}`,
      );
    const runRoot = resolve(spec.runRoot);
    const masterRoot = resolve(master.root);
    if (masterRoot === runRoot || masterRoot.startsWith(`${runRoot}${sep}`))
      throw new Error("Pseudo-fleet masters must stay outside the run root");
  }
}
