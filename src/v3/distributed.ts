import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson, hashText } from "../v2/hash.js";
import type { PeerEnrollmentRequest } from "./config.js";
import type {
  AdoptionPlan,
  HubConfig,
  ProductConfig,
  SyncSummary,
} from "./types.js";

export interface DistributedEndpoint {
  readonly kind: "local" | "ssh";
  readonly sshAlias?: string;
}

export interface DistributedMachineSpec {
  readonly machineId: string;
  readonly peerName: string;
  readonly endpoint: DistributedEndpoint;
  readonly command: readonly string[];
  readonly root: string;
  readonly stateDir: string;
  readonly configPath: string;
}

export interface DistributedTargetSpec extends DistributedMachineSpec {
  readonly requestPath: string;
  readonly role: "peer" | "hub";
}

export interface DistributedFleetSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly expectedVersion: string;
  readonly expectedReleaseSha256: string;
  readonly folderName: string;
  readonly backupWitness: string;
  readonly controllerStateDir: string;
  readonly hub: HubConfig;
  readonly authority: DistributedMachineSpec;
  readonly targets: readonly DistributedTargetSpec[];
}

export interface DistributedBuildIdentity {
  readonly version: string;
  readonly schemaVersion: number;
  readonly protocolVersion: number;
  readonly releaseSha256: string | null;
}

/** Machine operations are kept behind this boundary so the controller can be
 * tested through process-isolated agents before it is allowed to use SSH. */
export interface DistributedExecutor {
  inspect(machine: DistributedMachineSpec): Promise<DistributedBuildIdentity>;
  setupAuthority(
    machine: DistributedMachineSpec,
    input: {
      readonly folderName: string;
      readonly backupWitness: string;
      readonly hub: HubConfig;
    },
  ): Promise<ProductConfig>;
  prepareEnrollment(
    machine: DistributedTargetSpec,
    acceptedConfig: ProductConfig,
  ): Promise<PeerEnrollmentRequest>;
  enrollPeer(
    machine: DistributedMachineSpec,
    request: PeerEnrollmentRequest,
  ): Promise<ProductConfig>;
  activatePeer(
    machine: DistributedTargetSpec,
    acceptedConfig: ProductConfig,
    request: PeerEnrollmentRequest,
  ): Promise<ProductConfig>;
  sealSource(
    machine: DistributedMachineSpec,
    config: ProductConfig,
  ): Promise<SyncSummary>;
  planAdoption(
    machine: DistributedTargetSpec,
    config: ProductConfig,
    adoptionId: string,
  ): Promise<AdoptionPlan>;
  applyAdoption(
    machine: DistributedTargetSpec,
    config: ProductConfig,
    adoptionId: string,
  ): Promise<SyncSummary>;
  verify(
    machine: DistributedMachineSpec,
    config: ProductConfig,
  ): Promise<SyncSummary>;
}

interface DistributedJournal {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly specDigest: string;
  authority: ProductConfig | null;
  acceptedAuthority: ProductConfig | null;
  requests: Record<string, PeerEnrollmentRequest>;
  activated: Record<string, ProductConfig>;
  sourceSeal: SyncSummary | null;
  adoptionIds: Record<string, string>;
  plans: Record<string, AdoptionPlan>;
  applied: Record<string, SyncSummary>;
  verified: Record<string, SyncSummary>;
}

export interface DistributedSetupReport {
  readonly runId: string;
  readonly mutation: boolean;
  readonly exactBuild: boolean;
  readonly prepared: boolean;
  readonly cutoverReady: boolean;
  readonly servicesEnabled: false;
  readonly targets: readonly {
    readonly machineId: string;
    readonly prepared: boolean;
    readonly adoptionId: string | null;
    readonly applied: boolean;
    readonly verified: boolean;
  }[];
}

export function readDistributedFleetSpec(path: string): DistributedFleetSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  assertDistributedFleetSpec(value);
  return value;
}

export async function previewDistributedSetupV3(
  spec: DistributedFleetSpec,
  executor: DistributedExecutor,
): Promise<DistributedSetupReport> {
  validateDistributedFleetSpec(spec);
  await verifyBuilds(spec, executor);
  const journal = readJournal(spec);
  return report(spec, journal, false);
}

/** Prepares authority, enrollment, projections, source seal, and target plans.
 * It deliberately stops before the first target mutation. */
export async function prepareDistributedSetupV3(
  spec: DistributedFleetSpec,
  executor: DistributedExecutor,
): Promise<DistributedSetupReport> {
  validateDistributedFleetSpec(spec);
  await verifyBuilds(spec, executor);
  const journal = readOrCreateJournal(spec);
  if (journal.authority === null) {
    journal.authority = await executor.setupAuthority(spec.authority, {
      folderName: spec.folderName,
      backupWitness: spec.backupWitness,
      hub: spec.hub,
    });
    journal.acceptedAuthority = journal.authority;
    writeJournal(spec, journal);
  }
  for (const target of spec.targets) {
    if (journal.requests[target.machineId] !== undefined) continue;
    const authority = requiredAuthority(journal);
    journal.requests[target.machineId] = await executor.prepareEnrollment(
      target,
      authority,
    );
    writeJournal(spec, journal);
  }
  for (const target of spec.targets) {
    const request = requiredRequest(journal, target.machineId);
    const accepted = requiredAuthority(journal);
    if (
      accepted.peers.some(
        (peer) =>
          peer.peerId === request.peer.peerId &&
          canonicalJson(peer) === canonicalJson(request.peer),
      )
    )
      continue;
    journal.acceptedAuthority = await executor.enrollPeer(
      spec.authority,
      request,
    );
    writeJournal(spec, journal);
  }
  const accepted = requiredAuthority(journal);
  for (const target of spec.targets) {
    if (journal.activated[target.machineId] !== undefined) continue;
    journal.activated[target.machineId] = await executor.activatePeer(
      target,
      accepted,
      requiredRequest(journal, target.machineId),
    );
    writeJournal(spec, journal);
  }
  if (journal.sourceSeal === null) {
    journal.sourceSeal = await executor.sealSource(spec.authority, accepted);
    writeJournal(spec, journal);
  }
  for (const target of spec.targets) {
    if (journal.adoptionIds[target.machineId] === undefined) {
      journal.adoptionIds[target.machineId] = randomUUID();
      writeJournal(spec, journal);
    }
    if (journal.plans[target.machineId] !== undefined) continue;
    const adoptionId = requiredAdoptionId(journal, target.machineId);
    journal.plans[target.machineId] = await executor.planAdoption(
      target,
      requiredActivated(journal, target.machineId),
      adoptionId,
    );
    writeJournal(spec, journal);
  }
  return report(spec, journal, true);
}

/** Applies exactly one previously planned target after an external approval. */
export async function applyDistributedTargetV3(
  spec: DistributedFleetSpec,
  executor: DistributedExecutor,
  machineId: string,
  adoptionId: string,
): Promise<DistributedSetupReport> {
  validateDistributedFleetSpec(spec);
  await verifyBuilds(spec, executor);
  const target = spec.targets.find(
    (candidate) => candidate.machineId === machineId,
  );
  if (target === undefined)
    throw new Error(`Unknown distributed target: ${machineId}`);
  const journal = readJournal(spec);
  if (journal === null) throw new Error("Distributed setup is not prepared");
  const planned = journal.plans[machineId];
  if (planned === undefined || planned.adoptionId !== adoptionId)
    throw new Error(
      "Target approval does not match the prepared adoption plan",
    );
  const config = requiredActivated(journal, machineId);
  if (journal.applied[machineId] === undefined) {
    journal.applied[machineId] = await executor.applyAdoption(
      target,
      config,
      adoptionId,
    );
    writeJournal(spec, journal);
  }
  if (journal.verified[machineId] === undefined) {
    const verified = await executor.verify(target, config);
    if (verified.status !== "clean" && verified.status !== "conflict")
      throw new Error(`Target verification failed: ${machineId}`);
    journal.verified[machineId] = verified;
    writeJournal(spec, journal);
  }
  return report(spec, journal, true);
}

function report(
  spec: DistributedFleetSpec,
  journal: DistributedJournal | null,
  mutation: boolean,
): DistributedSetupReport {
  const targets = spec.targets.map((target) => ({
    machineId: target.machineId,
    prepared: journal?.plans[target.machineId] !== undefined,
    adoptionId: journal?.adoptionIds[target.machineId] ?? null,
    applied: journal?.applied[target.machineId] !== undefined,
    verified: journal?.verified[target.machineId] !== undefined,
  }));
  return {
    runId: spec.runId,
    mutation,
    exactBuild: true,
    prepared: targets.every((target) => target.prepared),
    cutoverReady: targets.every((target) => target.verified),
    servicesEnabled: false,
    targets,
  };
}

async function verifyBuilds(
  spec: DistributedFleetSpec,
  executor: DistributedExecutor,
): Promise<void> {
  const machines = [spec.authority, ...spec.targets];
  const builds = await Promise.all(
    machines.map(async (machine) => ({
      machine,
      identity: await executor.inspect(machine),
    })),
  );
  for (const { machine, identity } of builds) {
    if (
      identity.version !== spec.expectedVersion ||
      identity.schemaVersion !== 3 ||
      identity.protocolVersion !== 3 ||
      identity.releaseSha256 !== spec.expectedReleaseSha256
    )
      throw new Error(
        `Exact CodeFolderSync build mismatch: ${machine.machineId}`,
      );
  }
}

function readOrCreateJournal(spec: DistributedFleetSpec): DistributedJournal {
  const existing = readJournal(spec);
  if (existing !== null) return existing;
  const journal: DistributedJournal = {
    schemaVersion: 1,
    runId: spec.runId,
    specDigest: specDigest(spec),
    authority: null,
    acceptedAuthority: null,
    requests: {},
    activated: {},
    sourceSeal: null,
    adoptionIds: {},
    plans: {},
    applied: {},
    verified: {},
  };
  writeJournal(spec, journal);
  return journal;
}

function readJournal(spec: DistributedFleetSpec): DistributedJournal | null {
  const path = journalPath(spec);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Distributed setup journal is invalid");
  const journal = value as DistributedJournal;
  if (
    journal.schemaVersion !== 1 ||
    journal.runId !== spec.runId ||
    journal.specDigest !== specDigest(spec)
  )
    throw new Error(
      "Distributed setup journal does not match this specification",
    );
  return journal;
}

function writeJournal(
  spec: DistributedFleetSpec,
  journal: DistributedJournal,
): void {
  const path = journalPath(spec);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function journalPath(spec: DistributedFleetSpec): string {
  return join(resolve(spec.controllerStateDir), "distributed-setup.json");
}

function specDigest(spec: DistributedFleetSpec): string {
  return hashText(canonicalJson(spec));
}

function requiredAuthority(journal: DistributedJournal): ProductConfig {
  const authority = journal.acceptedAuthority ?? journal.authority;
  if (authority === null) throw new Error("Distributed authority is missing");
  return authority;
}

function requiredRequest(
  journal: DistributedJournal,
  machineId: string,
): PeerEnrollmentRequest {
  const request = journal.requests[machineId];
  if (request === undefined)
    throw new Error(`Distributed enrollment request is missing: ${machineId}`);
  return request;
}

function requiredActivated(
  journal: DistributedJournal,
  machineId: string,
): ProductConfig {
  const config = journal.activated[machineId];
  if (config === undefined)
    throw new Error(`Distributed target projection is missing: ${machineId}`);
  return config;
}

function requiredAdoptionId(
  journal: DistributedJournal,
  machineId: string,
): string {
  const adoptionId = journal.adoptionIds[machineId];
  if (adoptionId === undefined)
    throw new Error(`Distributed adoption ID is missing: ${machineId}`);
  return adoptionId;
}

function assertDistributedFleetSpec(
  value: unknown,
): asserts value is DistributedFleetSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Distributed fleet specification must be an object");
  validateDistributedFleetSpec(value as DistributedFleetSpec);
}

function validateDistributedFleetSpec(spec: DistributedFleetSpec): void {
  if (spec.schemaVersion !== 1)
    throw new Error("Distributed fleet specification schema is unsupported");
  safeId(spec.runId, "runId");
  nonEmpty(spec.expectedVersion, "expectedVersion");
  if (!/^[a-f0-9]{64}$/u.test(spec.expectedReleaseSha256))
    throw new Error("Expected release SHA-256 is invalid");
  nonEmpty(spec.folderName, "folderName");
  nonEmpty(spec.backupWitness, "backupWitness");
  absolute(spec.controllerStateDir, "controllerStateDir");
  if (spec.targets.length === 0)
    throw new Error("Distributed fleet requires at least one target");
  const machines = [spec.authority, ...spec.targets];
  const ids = machines.map((machine) => machine.machineId);
  const names = machines.map((machine) => machine.peerName);
  if (new Set(ids).size !== ids.length)
    throw new Error("Distributed machine IDs must be unique");
  if (new Set(names).size !== names.length)
    throw new Error("Distributed peer names must be unique");
  for (const machine of machines) validateMachine(machine);
  for (const target of spec.targets) {
    absolute(target.requestPath, `${target.machineId}.requestPath`);
    if (target.role !== "peer" && target.role !== "hub")
      throw new Error(
        `Distributed target role is invalid: ${target.machineId}`,
      );
  }
  const controller = resolve(spec.controllerStateDir);
  for (const machine of machines) {
    const root = resolve(machine.root);
    if (controller === root || controller.startsWith(`${root}${sep}`))
      throw new Error("Controller state must stay outside synchronized roots");
  }
}

function validateMachine(machine: DistributedMachineSpec): void {
  safeId(machine.machineId, "machineId");
  safeId(machine.peerName, "peerName");
  absolute(machine.root, `${machine.machineId}.root`);
  absolute(machine.stateDir, `${machine.machineId}.stateDir`);
  absolute(machine.configPath, `${machine.machineId}.configPath`);
  if (machine.command.length === 0)
    throw new Error(`Distributed command is missing: ${machine.machineId}`);
  for (const value of machine.command)
    if (value.length === 0 || value.includes("\0"))
      throw new Error(`Distributed command is invalid: ${machine.machineId}`);
  if (machine.endpoint.kind === "ssh") {
    const alias = machine.endpoint.sshAlias;
    if (alias === undefined || !/^[A-Za-z0-9_.@:-]+$/u.test(alias))
      throw new Error(`Distributed SSH alias is invalid: ${machine.machineId}`);
  } else if (machine.endpoint.sshAlias !== undefined) {
    throw new Error(
      `Local endpoint cannot name an SSH alias: ${machine.machineId}`,
    );
  }
}

function safeId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`Distributed ${name} is invalid`);
}

function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Distributed ${name} must be non-empty`);
}

function absolute(value: string, name: string): void {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`Distributed ${name} must be absolute`);
}
