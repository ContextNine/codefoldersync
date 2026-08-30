import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  installService,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
  type ServiceOptions,
} from "../v2/service.js";
import { canonicalJson } from "../v2/hash.js";
import { shellQuote } from "../executor.js";
import {
  createTreeWitness,
  includedLogicalBytes,
  makeTreeOwnerWritable,
  type TreeWitness,
} from "./acceptance.js";
import {
  aiWorkloadPrompt,
  createAiWorkloadFixture,
  replayAiMutationCassette,
  runAiWriter,
  type AiWriterResult,
} from "./ai-workload.js";
import { scanNamespace } from "./catalog.js";
import { ensureIgnore, loadConfig } from "./config.js";
import {
  applyDistributedTargetV3,
  cutoverDistributedAcceptanceV3,
  prepareDistributedSetupV3,
  type DistributedEndpoint,
  type DistributedFleetSpec,
} from "./distributed.js";
import { ProcessDistributedExecutor } from "./distributed-process.js";
import { verifyFullV3 } from "./engine.js";
import { ObjectStore } from "./objects.js";
import { LocalState } from "./state.js";
import { HubTransport } from "./transport.js";
import type { ServiceStatus, SyncSummary } from "./types.js";
import type { VisibilityEvent, VisibilityObserverSpec } from "./visibility.js";

export interface IsolatedMachineSpec {
  readonly machineId: string;
  readonly peerName: string;
  readonly sshAlias: string;
  readonly endpoint: DistributedEndpoint;
  readonly command: readonly string[];
  readonly runRoot: string;
  readonly masterRoot: string;
  readonly masterWitness: TreeWitness;
}

export interface IsolatedFleetAcceptanceSpec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly repetitions: 2;
  readonly expectedVersion: string;
  readonly expectedReleaseSha256: string;
  readonly backupWitness: string;
  readonly controllerStateDir: string;
  readonly sourceMachineId: string;
  readonly targetOrder: readonly string[];
  readonly hubMachineId: string;
  readonly machines: readonly IsolatedMachineSpec[];
  readonly aiWorkspaceName: string;
  readonly aiWriterCommand: readonly string[];
  readonly aiModelId: string;
  readonly aiPrompt: string;
  readonly observerPollIntervalMs: number;
  readonly timeoutMs: number;
}

interface PreparedMachine {
  readonly machineId: string;
  readonly repetitionId: string;
  readonly workspaceWitness: TreeWitness;
  readonly masterWitness: TreeWitness;
  readonly passed: true;
}

interface SemanticResult {
  readonly digest: string;
  readonly entries: number;
  readonly gitBoundaries: number;
}

interface HubVisibilityEvent {
  readonly kind: "ready" | "checkpoint" | "offline" | "timeout";
  readonly sequence: number | null;
  readonly snapshotDigest: string | null;
}

export interface IsolatedFleetRunResult {
  readonly repetition: number;
  readonly mode: "real-model" | "cassette-replay";
  readonly modelId: string;
  readonly promptDigest: string;
  readonly initialDigest: string;
  readonly finalDigest: string;
  readonly cassetteDigest: string;
  readonly semanticDigest: string;
  readonly changedCodeFiles: number;
  readonly changedDirectories: number;
  readonly timings: {
    readonly writerDurationMs: number;
    readonly firstSourceChangeMs: number;
    readonly writerCompleteToHubMs: number;
    readonly writerCompleteToTargetsMs: Readonly<Record<string, number>>;
    readonly allTargetsConvergedMs: number;
    readonly pathVisibilityMs: {
      readonly p50: number;
      readonly p95: number;
      readonly maximum: number;
    };
  };
  readonly services: Readonly<Record<string, "stopped-and-uninstalled">>;
  readonly passed: true;
}

export interface IsolatedMachineCapacityObservation {
  readonly schemaVersion: 1;
  readonly machineId: string;
  readonly workspaceBytesPerRepetition: number;
  readonly includedBytesPerRepetition: number;
  readonly availableBytes: number;
}

export interface IsolatedMachineCapacityEstimate extends IsolatedMachineCapacityObservation {
  readonly localObjectStoreBytesPerRepetition: number;
  readonly hubObjectStoreBytesPerRepetition: number;
  readonly recoveryBytesPerRepetition: number;
  readonly projectedBytesPerRepetition: number;
  readonly requiredBytes: number;
  readonly reserveFactor: 1.25;
  readonly passed: boolean;
}

export interface IsolatedFleetCapacityEstimate {
  readonly schemaVersion: 1;
  readonly repetitions: 2;
  readonly machines: readonly IsolatedMachineCapacityEstimate[];
  readonly passed: boolean;
}

type IsolatedAgentRequest =
  | {
      readonly action: "ssh-matrix";
      readonly expectedVersion: string;
      readonly expectedReleaseSha256: string;
      readonly peers: readonly {
        readonly machineId: string;
        readonly sshAlias: string;
        readonly command: readonly string[];
      }[];
    }
  | {
      readonly action: "prepare";
      readonly machineId: string;
      readonly baseRunId: string;
      readonly repetitionId: string;
      readonly baseRunRoot: string;
      readonly repetitionRoot: string;
      readonly workspace: string;
      readonly masterRoot: string;
      readonly masterWitness: TreeWitness;
      readonly aiWorkspace: string;
      readonly createAiWorkspace: boolean;
    }
  | {
      readonly action: "capacity";
      readonly machineId: string;
      readonly baseRunId: string;
      readonly baseRunRoot: string;
      readonly masterRoot: string;
      readonly masterWitness: TreeWitness;
    }
  | {
      readonly action: "ai-writer";
      readonly repetitionId: string;
      readonly repetitionRoot: string;
      readonly workspace: string;
      readonly privateEvidenceDir: string;
      readonly command: readonly string[];
      readonly modelId: string;
      readonly prompt: string;
      readonly timeoutMs: number;
      readonly pollIntervalMs: number;
    }
  | {
      readonly action: "ai-replay";
      readonly repetitionId: string;
      readonly repetitionRoot: string;
      readonly workspace: string;
      readonly cassettePath: string;
      readonly cassetteRepetitionId: string;
      readonly cassetteRepetitionRoot: string;
    }
  | {
      readonly action: "service";
      readonly repetitionId: string;
      readonly repetitionRoot: string;
      readonly configPath: string;
      readonly definitionDirectory: string;
      readonly command: readonly string[];
      readonly serviceAction:
        "install" | "start" | "restart" | "stop" | "status" | "uninstall";
    }
  | {
      readonly action: "semantic" | "verify";
      readonly repetitionId: string;
      readonly repetitionRoot: string;
      readonly configPath: string;
    };

export interface HubVisibilityObserverSpec {
  readonly schemaVersion: 1;
  readonly repetitionId: string;
  readonly repetitionRoot: string;
  readonly configPath: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
}

export function readIsolatedFleetAcceptanceSpec(
  path: string,
): IsolatedFleetAcceptanceSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  assertIsolatedSpec(value);
  return value;
}

export async function runIsolatedAgent(request: unknown): Promise<unknown> {
  const input = isolatedAgentRequest(request);
  switch (input.action) {
    case "ssh-matrix":
      return verifyRemoteSshPeers(input);
    case "prepare":
      return prepareMachine(input);
    case "capacity":
      return measureIsolatedMachineCapacity(input);
    case "ai-writer":
      assertRunBoundary(
        input.repetitionId,
        input.repetitionRoot,
        input.workspace,
      );
      return runAiWriter({
        runId: input.repetitionId,
        allowedRunRoot: input.repetitionRoot,
        workspace: input.workspace,
        privateEvidenceDir: input.privateEvidenceDir,
        command: input.command,
        modelId: input.modelId,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        pollIntervalMs: input.pollIntervalMs,
      });
    case "ai-replay":
      assertRunBoundary(
        input.repetitionId,
        input.repetitionRoot,
        input.workspace,
      );
      assertRunBoundary(
        input.cassetteRepetitionId,
        input.cassetteRepetitionRoot,
        input.cassettePath,
      );
      return replayAiMutationCassette(input.cassettePath, input.workspace);
    case "service":
      return runIsolatedService(input);
    case "semantic":
      return semanticResult(input);
    case "verify": {
      assertRunBoundary(
        input.repetitionId,
        input.repetitionRoot,
        input.configPath,
      );
      return verifyFullV3(loadConfig(input.configPath));
    }
  }
}

export async function runHubVisibilityObserver(
  value: unknown,
  emit: (event: HubVisibilityEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const spec = hubVisibilitySpec(value);
  assertRunBoundary(spec.repetitionId, spec.repetitionRoot, spec.configPath);
  const config = loadConfig(spec.configPath);
  let lastSequence: number | null = null;
  const started = Date.now();
  while (!isAborted(signal) && Date.now() - started < spec.timeoutMs) {
    try {
      await using transport = await HubTransport.connectForPeer(config);
      while (!isAborted(signal) && Date.now() - started < spec.timeoutMs) {
        const checkpoint = await transport.checkpoint(config.folderId);
        if (lastSequence === null) {
          lastSequence = checkpoint.sequence;
          emit({
            kind: "ready",
            sequence: checkpoint.sequence,
            snapshotDigest: checkpoint.snapshot?.digest ?? null,
          });
        } else if (checkpoint.sequence !== lastSequence) {
          lastSequence = checkpoint.sequence;
          emit({
            kind: "checkpoint",
            sequence: checkpoint.sequence,
            snapshotDigest: checkpoint.snapshot?.digest ?? null,
          });
        }
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, spec.pollIntervalMs),
        );
      }
    } catch {
      emit({ kind: "offline", sequence: lastSequence, snapshotDigest: null });
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, spec.pollIntervalMs),
      );
    }
  }
  if (!isAborted(signal))
    emit({ kind: "timeout", sequence: lastSequence, snapshotDigest: null });
}

export async function runIsolatedFleetAcceptanceV3(
  spec: IsolatedFleetAcceptanceSpec,
): Promise<readonly IsolatedFleetRunResult[]> {
  const capacity = await estimateIsolatedFleetCapacityV3(spec);
  if (!capacity.passed) {
    const failures = capacity.machines
      .filter((entry) => !entry.passed)
      .map(
        (entry) =>
          `${entry.machineId} requires ${entry.requiredBytes} bytes and has ${entry.availableBytes}`,
      )
      .join("; ");
    throw new Error(
      `Isolated fleet lacks its two-run copy, object, recovery, and 25 percent reserve: ${failures}`,
    );
  }
  const source = machine(spec, spec.sourceMachineId);
  const hub = machine(spec, spec.hubMachineId);
  const targets = spec.targetOrder.map((machineId) => machine(spec, machineId));
  const executor = new ProcessDistributedExecutor();
  const results: IsolatedFleetRunResult[] = [];
  let cassettePath: string | null = null;
  let cassetteRepetitionId: string | null = null;
  let cassetteRepetitionRoot: string | null = null;
  let acceptedAi: AiWriterResult | null = null;
  for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
    const repetitionId = `${spec.runId}-${spec.scenarioId}-${String(repetition).padStart(2, "0")}`;
    const layouts = new Map(
      spec.machines.map((entry) => [
        entry.machineId,
        machineLayout(spec, entry, repetitionId),
      ]),
    );
    await Promise.all(
      spec.machines.map(async (entry) => {
        const layout = requiredLayout(layouts, entry.machineId);
        await callIsolatedAgent(entry, {
          action: "prepare",
          machineId: entry.machineId,
          baseRunId: spec.runId,
          repetitionId,
          baseRunRoot: entry.runRoot,
          repetitionRoot: layout.repetitionRoot,
          workspace: layout.workspace,
          masterRoot: entry.masterRoot,
          masterWitness: entry.masterWitness,
          aiWorkspace: layout.aiWorkspace,
          createAiWorkspace: entry.machineId === spec.sourceMachineId,
        });
      }),
    );
    const distributed = distributedSpec(
      spec,
      repetitionId,
      source,
      hub,
      targets,
      layouts,
    );
    const prepared = await prepareDistributedSetupV3(distributed, executor);
    for (const target of prepared.targets) {
      if (target.adoptionId === null)
        throw new Error("Isolated target adoption ID is missing");
      await applyDistributedTargetV3(
        distributed,
        executor,
        target.machineId,
        target.adoptionId,
      );
    }
    await cutoverDistributedAcceptanceV3(distributed, executor);
    await installAndStartServices(spec, repetitionId, layouts);

    const controllerStarted = performance.now();
    const workspaceObservers = new Map<
      string,
      JsonLineProcess<VisibilityEvent>
    >();
    let hubObserver: JsonLineProcess<HubVisibilityEvent> | null = null;
    try {
      for (const entry of spec.machines) {
        const layout = requiredLayout(layouts, entry.machineId);
        const observer = startJsonLineProcess<VisibilityEvent>(
          entry,
          "visibility-agent",
          {
            schemaVersion: 1,
            runId: repetitionId,
            allowedRunRoot: layout.repetitionRoot,
            workspace: layout.aiWorkspace,
            pollIntervalMs: spec.observerPollIntervalMs,
            timeoutMs: spec.timeoutMs,
          } satisfies VisibilityObserverSpec,
          controllerStarted,
        );
        workspaceObservers.set(entry.machineId, observer);
      }
      const hubLayout = requiredLayout(layouts, hub.machineId);
      hubObserver = startJsonLineProcess<HubVisibilityEvent>(
        hub,
        "hub-visibility-agent",
        {
          schemaVersion: 1,
          repetitionId,
          repetitionRoot: hubLayout.repetitionRoot,
          configPath: hubLayout.configPath,
          pollIntervalMs: spec.observerPollIntervalMs,
          timeoutMs: spec.timeoutMs,
        } satisfies HubVisibilityObserverSpec,
        controllerStarted,
      );
      await Promise.all([
        ...[...workspaceObservers.values()].map((observer) =>
          observer.waitFor((event) => event.kind === "ready", spec.timeoutMs),
        ),
        hubObserver.waitFor((event) => event.kind === "ready", spec.timeoutMs),
      ]);
      const sourceLayout = requiredLayout(layouts, source.machineId);
      const writerStartedMs = elapsed(controllerStarted);
      let writer: AiWriterResult;
      if (repetition === 1) {
        writer = aiWriterResult(
          await callIsolatedAgent(source, {
            action: "ai-writer",
            repetitionId,
            repetitionRoot: sourceLayout.repetitionRoot,
            workspace: sourceLayout.aiWorkspace,
            privateEvidenceDir: sourceLayout.privateEvidenceDir,
            command: spec.aiWriterCommand,
            modelId: spec.aiModelId,
            prompt: spec.aiPrompt,
            timeoutMs: spec.timeoutMs,
            pollIntervalMs: spec.observerPollIntervalMs,
          }),
        );
        acceptedAi = writer;
        cassettePath = join(
          sourceLayout.privateEvidenceDir,
          "ai-mutation-cassette.json",
        );
        cassetteRepetitionId = repetitionId;
        cassetteRepetitionRoot = sourceLayout.repetitionRoot;
      } else {
        if (
          cassettePath === null ||
          cassetteRepetitionId === null ||
          cassetteRepetitionRoot === null ||
          acceptedAi === null
        )
          throw new Error("AI mutation cassette is missing for replay");
        await callIsolatedAgent(source, {
          action: "ai-replay",
          repetitionId,
          repetitionRoot: sourceLayout.repetitionRoot,
          workspace: sourceLayout.aiWorkspace,
          cassettePath,
          cassetteRepetitionId,
          cassetteRepetitionRoot,
        });
        writer = {
          ...acceptedAi,
          writerDurationMs: elapsed(controllerStarted) - writerStartedMs,
          firstChangeMs: 0,
          lastChangeMs: 0,
        };
      }
      const writerCompletedMs = elapsed(controllerStarted);
      const sourceSemantic = semanticResultValue(
        await callIsolatedAgent(source, {
          action: "semantic",
          repetitionId,
          repetitionRoot: sourceLayout.repetitionRoot,
          configPath: sourceLayout.configPath,
        }),
      );
      const convergence = await waitForConvergence(
        spec,
        writer,
        source.machineId,
        targets.map((entry) => entry.machineId),
        workspaceObservers,
        hubObserver,
        sourceSemantic.digest,
        writerStartedMs,
        writerCompletedMs,
      );
      const semantic = await verifySemantics(spec, repetitionId, layouts);
      await restartAndVerifyServices(spec, repetitionId, layouts);
      const services = await stopAndUninstallServices(
        spec,
        repetitionId,
        layouts,
      );
      await verifyPreparedMasters(spec, repetitionId, layouts);
      const result: IsolatedFleetRunResult = {
        repetition,
        mode: repetition === 1 ? "real-model" : "cassette-replay",
        modelId: writer.modelId,
        promptDigest: writer.promptDigest,
        initialDigest: writer.initialDigest,
        finalDigest: writer.finalDigest,
        cassetteDigest: writer.cassetteDigest,
        semanticDigest: semantic,
        changedCodeFiles: writer.changedCodeFiles,
        changedDirectories: writer.changedDirectories,
        timings: {
          writerDurationMs: milliseconds(writerCompletedMs - writerStartedMs),
          ...convergence,
        },
        services,
        passed: true,
      };
      atomicPrivateJson(
        join(
          spec.controllerStateDir,
          repetitionId,
          "controller",
          "result.json",
        ),
        result,
      );
      results.push(result);
    } finally {
      for (const observer of workspaceObservers.values()) await observer.stop();
      if (hubObserver !== null) await hubObserver.stop();
      await stopServicesBestEffort(spec, repetitionId, layouts);
    }
  }
  if (results[0]?.finalDigest !== results[1]?.finalDigest)
    throw new Error("AI replay final digest differs from the real model run");
  return results;
}

export async function estimateIsolatedFleetCapacityV3(
  spec: IsolatedFleetAcceptanceSpec,
): Promise<IsolatedFleetCapacityEstimate> {
  validateIsolatedSpec(spec);
  assertExactSentinel(spec.controllerStateDir, spec.runId);
  await verifySshMatrix(spec);
  const observations = await Promise.all(
    spec.machines.map(async (entry) =>
      isolatedMachineCapacityObservation(
        await callIsolatedAgent(entry, {
          action: "capacity",
          machineId: entry.machineId,
          baseRunId: spec.runId,
          baseRunRoot: entry.runRoot,
          masterRoot: entry.masterRoot,
          masterWitness: entry.masterWitness,
        }),
      ),
    ),
  );
  return projectIsolatedFleetCapacityV3(spec, observations);
}

export function projectIsolatedFleetCapacityV3(
  spec: IsolatedFleetAcceptanceSpec,
  observations: readonly IsolatedMachineCapacityObservation[],
): IsolatedFleetCapacityEstimate {
  const byMachine = new Map(
    observations.map((entry) => [entry.machineId, entry]),
  );
  if (
    observations.length !== spec.machines.length ||
    byMachine.size !== spec.machines.length ||
    spec.machines.some((entry) => !byMachine.has(entry.machineId))
  )
    throw new Error("Isolated capacity observations do not match the fleet");
  const sourceIncluded = requiredCapacityObservation(
    byMachine,
    spec.sourceMachineId,
  ).includedBytesPerRepetition;
  const totalIncluded = observations.reduce(
    (total, entry) => total + entry.includedBytesPerRepetition,
    0,
  );
  const reserveFactor = 1.25 as const;
  const machines = spec.machines.map((machineSpec) => {
    const observation = requiredCapacityObservation(
      byMachine,
      machineSpec.machineId,
    );
    const target = spec.targetOrder.includes(machineSpec.machineId);
    const localObjectStoreBytesPerRepetition =
      sourceIncluded + (target ? observation.includedBytesPerRepetition : 0);
    const hubObjectStoreBytesPerRepetition =
      machineSpec.machineId === spec.hubMachineId ? totalIncluded : 0;
    const recoveryBytesPerRepetition = target
      ? observation.includedBytesPerRepetition
      : 0;
    const projectedBytesPerRepetition =
      observation.workspaceBytesPerRepetition +
      localObjectStoreBytesPerRepetition +
      hubObjectStoreBytesPerRepetition +
      recoveryBytesPerRepetition;
    const requiredBytes = Math.ceil(
      projectedBytesPerRepetition * spec.repetitions * reserveFactor,
    );
    return {
      ...observation,
      localObjectStoreBytesPerRepetition,
      hubObjectStoreBytesPerRepetition,
      recoveryBytesPerRepetition,
      projectedBytesPerRepetition,
      requiredBytes,
      reserveFactor,
      passed: observation.availableBytes >= requiredBytes,
    } satisfies IsolatedMachineCapacityEstimate;
  });
  return {
    schemaVersion: 1,
    repetitions: 2,
    machines,
    passed: machines.every((entry) => entry.passed),
  };
}

async function measureIsolatedMachineCapacity(
  input: Extract<IsolatedAgentRequest, { readonly action: "capacity" }>,
): Promise<IsolatedMachineCapacityObservation> {
  assertExactSentinel(input.baseRunRoot, input.baseRunId);
  const masterWitness = await createTreeWitness(input.masterRoot);
  if (canonicalJson(masterWitness) !== canonicalJson(input.masterWitness))
    throw new Error(
      "Isolated master witness changed before capacity preflight",
    );
  const filesystem = statfsSync(resolve(input.baseRunRoot));
  return {
    schemaVersion: 1,
    machineId: input.machineId,
    workspaceBytesPerRepetition: masterWitness.bytes,
    includedBytesPerRepetition: includedLogicalBytes(input.masterRoot),
    availableBytes: filesystem.bavail * filesystem.bsize,
  };
}

function isolatedMachineCapacityObservation(
  value: unknown,
): IsolatedMachineCapacityObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated capacity agent returned an invalid result");
  const observation = value as Partial<IsolatedMachineCapacityObservation>;
  if (
    observation.schemaVersion !== 1 ||
    typeof observation.machineId !== "string" ||
    !isCapacityByteCount(observation.workspaceBytesPerRepetition) ||
    !isCapacityByteCount(observation.includedBytesPerRepetition) ||
    !isCapacityByteCount(observation.availableBytes)
  )
    throw new Error("Isolated capacity agent returned an invalid result");
  return observation as IsolatedMachineCapacityObservation;
}

function isCapacityByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requiredCapacityObservation(
  observations: ReadonlyMap<string, IsolatedMachineCapacityObservation>,
  machineId: string,
): IsolatedMachineCapacityObservation {
  const observation = observations.get(machineId);
  if (observation === undefined)
    throw new Error(`Isolated capacity is missing: ${machineId}`);
  return observation;
}

async function prepareMachine(
  input: Extract<IsolatedAgentRequest, { readonly action: "prepare" }>,
): Promise<PreparedMachine> {
  assertExactSentinel(input.baseRunRoot, input.baseRunId);
  const base = resolve(input.baseRunRoot);
  const repetitionRoot = resolve(input.repetitionRoot);
  if (!repetitionRoot.startsWith(`${base}${sep}`))
    throw new Error("Isolated repetition escapes the base run root");
  assertDescendant(repetitionRoot, input.workspace);
  assertDescendant(input.workspace, input.aiWorkspace);
  const marker = join(repetitionRoot, ".prepared.json");
  if (existsSync(marker)) {
    assertExactSentinel(repetitionRoot, input.repetitionId);
    const value = JSON.parse(readFileSync(marker, "utf8")) as PreparedMachine;
    if (
      value.repetitionId !== input.repetitionId ||
      value.machineId !== input.machineId
    )
      throw new Error("Isolated prepared marker does not match");
    const currentMaster = await createTreeWitness(input.masterRoot);
    if (
      canonicalJson(currentMaster) !== canonicalJson(input.masterWitness) ||
      canonicalJson(value.masterWitness) !== canonicalJson(input.masterWitness)
    )
      throw new Error("Isolated master witness changed after copy");
    return value;
  }
  if (existsSync(repetitionRoot))
    throw new Error(
      "Isolated repetition root exists without a prepared marker",
    );
  const masterBefore = await createTreeWitness(input.masterRoot);
  if (canonicalJson(masterBefore) !== canonicalJson(input.masterWitness))
    throw new Error("Isolated master witness changed before copy");
  const filesystem = statfsSync(base);
  const available = filesystem.bavail * filesystem.bsize;
  if (available < Math.ceil(input.masterWitness.bytes * 1.25))
    throw new Error("Isolated run root lacks the 25 percent copy reserve");
  mkdirSync(repetitionRoot, { recursive: false, mode: 0o700 });
  writeFileSync(join(repetitionRoot, "SENTINEL"), `${input.repetitionId}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  cpSync(resolve(input.masterRoot), resolve(input.workspace), {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  makeTreeOwnerWritable(input.workspace);
  if (existsSync(input.aiWorkspace))
    throw new Error("AI fixture path already exists in the copied master");
  if (input.createAiWorkspace) createAiWorkloadFixture(input.aiWorkspace);
  const masterAfter = await createTreeWitness(input.masterRoot);
  if (canonicalJson(masterAfter) !== canonicalJson(input.masterWitness))
    throw new Error("Isolated master witness changed during copy");
  const prepared: PreparedMachine = {
    machineId: input.machineId,
    repetitionId: input.repetitionId,
    workspaceWitness: await createTreeWitness(input.workspace),
    masterWitness: masterAfter,
    passed: true,
  };
  atomicPrivateJson(marker, prepared);
  return prepared;
}

function runIsolatedService(
  input: Extract<IsolatedAgentRequest, { readonly action: "service" }>,
): ServiceStatus | { readonly recovered: true } {
  assertRunBoundary(input.repetitionId, input.repetitionRoot, input.configPath);
  assertRunBoundary(
    input.repetitionId,
    input.repetitionRoot,
    input.definitionDirectory,
  );
  const config = loadConfig(input.configPath);
  const options = serviceOptions(
    input.configPath,
    input.definitionDirectory,
    input.command,
  );
  switch (input.serviceAction) {
    case "install":
      return installService(config, { ...options, activate: false });
    case "start":
      startService(config, options);
      return serviceStatus(config, options);
    case "restart":
      restartService(config);
      return serviceStatus(config, options);
    case "stop":
      stopService(config);
      return serviceStatus(config, options);
    case "status":
      return serviceStatus(config, options);
    case "uninstall":
      uninstallService(config, options);
      return { recovered: true };
  }
}

function verifyRemoteSshPeers(
  input: Extract<IsolatedAgentRequest, { readonly action: "ssh-matrix" }>,
): { readonly verifiedPeers: number; readonly passed: true } {
  for (const peer of input.peers) {
    if (!/^[A-Za-z0-9_.@:-]+$/u.test(peer.sshAlias))
      throw new Error("Isolated SSH matrix alias is invalid");
    const command = peer.command[0];
    if (command === undefined || !isAbsolute(command))
      throw new Error("Isolated SSH matrix command is invalid");
    const remote = [...peer.command, "--version", "--json"]
      .map(shellQuote)
      .join(" ");
    const result = spawnSync(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=10",
        peer.sshAlias,
        remote,
      ],
      { encoding: "utf8", env: minimalEnvironment(), maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error(`Isolated SSH matrix failed: ${peer.machineId}`);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(
        `Isolated SSH matrix returned invalid JSON: ${peer.machineId}`,
      );
    }
    const identity = value as {
      readonly version?: unknown;
      readonly schemaVersion?: unknown;
      readonly protocolVersion?: unknown;
      readonly releaseSha256?: unknown;
    };
    if (
      identity.version !== input.expectedVersion ||
      identity.schemaVersion !== 3 ||
      identity.protocolVersion !== 3 ||
      identity.releaseSha256 !== input.expectedReleaseSha256
    )
      throw new Error(`Isolated SSH matrix build mismatch: ${peer.machineId}`);
  }
  return { verifiedPeers: input.peers.length, passed: true };
}

function semanticResult(
  input: Extract<
    IsolatedAgentRequest,
    { readonly action: "semantic" | "verify" }
  >,
): SemanticResult {
  assertRunBoundary(input.repetitionId, input.repetitionRoot, input.configPath);
  const config = loadConfig(input.configPath);
  using state = new LocalState(config);
  using objects = new ObjectStore(join(config.stateDir, "objects"));
  const scanned = scanNamespace(
    config,
    objects,
    ensureIgnore(config.root),
    state.catalog(),
    true,
  );
  return {
    digest: scanned.manifest.digest,
    entries: scanned.manifest.entries.length,
    gitBoundaries: scanned.manifest.gitBoundaries.length,
  };
}

function serviceOptions(
  configPath: string,
  definitionDirectory: string,
  command: readonly string[],
): ServiceOptions {
  const executablePath = command[0];
  if (executablePath === undefined)
    throw new Error("Isolated service command is missing");
  if (command.length > 2)
    throw new Error("Isolated service command has too many fixed arguments");
  const scriptPath = command[1];
  return {
    configPath,
    executablePath,
    ...(scriptPath === undefined ? {} : { scriptPath }),
    definitionDirectory,
    activate: false,
  };
}

function machineLayout(
  spec: IsolatedFleetAcceptanceSpec,
  machineSpec: IsolatedMachineSpec,
  repetitionId: string,
) {
  const repetitionRoot = join(machineSpec.runRoot, repetitionId);
  const workspace = join(repetitionRoot, "Code");
  return {
    repetitionRoot,
    workspace,
    stateDir: join(repetitionRoot, "state"),
    configPath: join(workspace, ".codefoldersync", "config.json"),
    requestPath: join(repetitionRoot, "enrollment-request.json"),
    definitionDirectory: join(repetitionRoot, "service-definitions"),
    privateEvidenceDir: join(repetitionRoot, "private-evidence"),
    aiWorkspace: join(workspace, spec.aiWorkspaceName),
    hub: join(repetitionRoot, "hub"),
  };
}

type MachineLayout = ReturnType<typeof machineLayout>;

function distributedSpec(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  source: IsolatedMachineSpec,
  hub: IsolatedMachineSpec,
  targets: readonly IsolatedMachineSpec[],
  layouts: ReadonlyMap<string, MachineLayout>,
): DistributedFleetSpec {
  const distributedMachine = (entry: IsolatedMachineSpec) => {
    const layout = requiredLayout(layouts, entry.machineId);
    return {
      machineId: entry.machineId,
      peerName: entry.peerName,
      endpoint: entry.endpoint,
      command: entry.command,
      root: layout.workspace,
      stateDir: layout.stateDir,
      configPath: layout.configPath,
    };
  };
  const hubLayout = requiredLayout(layouts, hub.machineId);
  return {
    schemaVersion: 1,
    runId: repetitionId,
    expectedVersion: spec.expectedVersion,
    expectedReleaseSha256: spec.expectedReleaseSha256,
    folderName: `isolated-${repetitionId}`,
    backupWitness: spec.backupWitness,
    controllerStateDir: join(
      spec.controllerStateDir,
      repetitionId,
      "controller",
    ),
    hub: {
      kind: "ssh",
      host: hub.sshAlias,
      path: hubLayout.hub,
      command: hub.command,
    },
    authority: distributedMachine(source),
    targets: targets.map((entry) => ({
      ...distributedMachine(entry),
      role: entry.machineId === hub.machineId ? "hub" : "peer",
      requestPath: requiredLayout(layouts, entry.machineId).requestPath,
    })),
  };
}

async function installAndStartServices(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<void> {
  const installed: IsolatedMachineSpec[] = [];
  try {
    for (const entry of spec.machines) {
      const status = serviceStatusResult(
        await serviceCall(spec, entry, repetitionId, layouts, "install"),
      );
      if (!status.installed || status.running)
        throw new Error("Isolated service did not install disabled");
      installed.push(entry);
    }
    for (const entry of spec.machines) {
      const status = serviceStatusResult(
        await serviceCall(spec, entry, repetitionId, layouts, "start"),
      );
      if (!status.running) throw new Error("Isolated service did not start");
    }
  } catch (error) {
    for (const entry of installed.toReversed()) {
      await serviceCall(spec, entry, repetitionId, layouts, "uninstall").catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function restartAndVerifyServices(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<void> {
  for (const entry of spec.machines) {
    const status = serviceStatusResult(
      await serviceCall(spec, entry, repetitionId, layouts, "restart"),
    );
    if (!status.running) throw new Error("Isolated service restart failed");
    const layout = requiredLayout(layouts, entry.machineId);
    const verified = syncSummary(
      await callIsolatedAgent(entry, {
        action: "verify",
        repetitionId,
        repetitionRoot: layout.repetitionRoot,
        configPath: layout.configPath,
      }),
    );
    if (verified.status !== "clean")
      throw new Error("Isolated verification failed after service restart");
  }
}

async function stopAndUninstallServices(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<Readonly<Record<string, "stopped-and-uninstalled">>> {
  const result: Record<string, "stopped-and-uninstalled"> = {};
  for (const entry of spec.machines) {
    const stopped = serviceStatusResult(
      await serviceCall(spec, entry, repetitionId, layouts, "stop"),
    );
    if (stopped.running) throw new Error("Isolated service did not stop");
    await serviceCall(spec, entry, repetitionId, layouts, "uninstall");
    result[entry.machineId] = "stopped-and-uninstalled";
  }
  return result;
}

async function verifyPreparedMasters(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<void> {
  await Promise.all(
    spec.machines.map(async (entry) => {
      const layout = requiredLayout(layouts, entry.machineId);
      await callIsolatedAgent(entry, {
        action: "prepare",
        machineId: entry.machineId,
        baseRunId: spec.runId,
        repetitionId,
        baseRunRoot: entry.runRoot,
        repetitionRoot: layout.repetitionRoot,
        workspace: layout.workspace,
        masterRoot: entry.masterRoot,
        masterWitness: entry.masterWitness,
        aiWorkspace: layout.aiWorkspace,
        createAiWorkspace: entry.machineId === spec.sourceMachineId,
      });
    }),
  );
}

async function stopServicesBestEffort(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<void> {
  for (const entry of spec.machines) {
    await serviceCall(spec, entry, repetitionId, layouts, "uninstall").catch(
      () => undefined,
    );
  }
}

async function verifySshMatrix(
  spec: IsolatedFleetAcceptanceSpec,
): Promise<void> {
  await Promise.all(
    spec.machines.map((origin) =>
      callIsolatedAgent(origin, {
        action: "ssh-matrix",
        expectedVersion: spec.expectedVersion,
        expectedReleaseSha256: spec.expectedReleaseSha256,
        peers: spec.machines
          .filter((target) => target.machineId !== origin.machineId)
          .map((target) => ({
            machineId: target.machineId,
            sshAlias: target.sshAlias,
            command: target.command,
          })),
      }),
    ),
  );
}

function serviceCall(
  spec: IsolatedFleetAcceptanceSpec,
  entry: IsolatedMachineSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
  serviceAction: Extract<
    IsolatedAgentRequest,
    { readonly action: "service" }
  >["serviceAction"],
): Promise<unknown> {
  const layout = requiredLayout(layouts, entry.machineId);
  return callIsolatedAgent(entry, {
    action: "service",
    repetitionId,
    repetitionRoot: layout.repetitionRoot,
    configPath: layout.configPath,
    definitionDirectory: layout.definitionDirectory,
    command: entry.command,
    serviceAction,
  });
}

async function verifySemantics(
  spec: IsolatedFleetAcceptanceSpec,
  repetitionId: string,
  layouts: ReadonlyMap<string, MachineLayout>,
): Promise<string> {
  const semantic = await Promise.all(
    spec.machines.map(async (entry) => {
      const layout = requiredLayout(layouts, entry.machineId);
      const verified = syncSummary(
        await callIsolatedAgent(entry, {
          action: "verify",
          repetitionId,
          repetitionRoot: layout.repetitionRoot,
          configPath: layout.configPath,
        }),
      );
      if (verified.status !== "clean")
        throw new Error("Isolated full verification failed");
      return semanticResultValue(
        await callIsolatedAgent(entry, {
          action: "semantic",
          repetitionId,
          repetitionRoot: layout.repetitionRoot,
          configPath: layout.configPath,
        }),
      );
    }),
  );
  const digests = new Set(semantic.map((entry) => entry.digest));
  if (digests.size !== 1)
    throw new Error("Isolated peers did not reach one semantic digest");
  const digest = semantic[0]?.digest;
  if (digest === undefined)
    throw new Error("Isolated semantic digest is missing");
  return digest;
}

async function waitForConvergence(
  spec: IsolatedFleetAcceptanceSpec,
  writer: AiWriterResult,
  sourceMachineId: string,
  targetIds: readonly string[],
  observers: ReadonlyMap<string, JsonLineProcess<VisibilityEvent>>,
  hubObserver: JsonLineProcess<HubVisibilityEvent>,
  expectedHubDigest: string,
  writerStartedMs: number,
  writerCompletedMs: number,
) {
  const source = requiredObserver(observers, sourceMachineId);
  const firstSource = await source.waitFor(
    (event) => event.kind === "change",
    spec.timeoutMs,
  );
  const hubAccepted = await hubObserver.waitFor(
    (event) => event.snapshotDigest === expectedHubDigest,
    spec.timeoutMs,
  );
  const targetFinal = await Promise.all(
    targetIds.map(async (machineId) => {
      const observer = requiredObserver(observers, machineId);
      const final = await observer.waitFor(
        (event) =>
          event.kind === "change" && event.treeDigest === writer.finalDigest,
        spec.timeoutMs,
      );
      for (const expected of writer.finalPathStates)
        await observer.waitFor(
          (event) =>
            event.kind === "change" &&
            event.pathHash === expected.pathHash &&
            event.stateDigest === expected.stateDigest,
          spec.timeoutMs,
        );
      return [machineId, final.receivedMs] as const;
    }),
  );
  const targetTimes = Object.fromEntries(targetFinal);
  const pathLatencies: number[] = [];
  for (const expected of writer.finalPathStates) {
    const sourceChange = await source.waitFor(
      (event) =>
        event.kind === "change" &&
        event.pathHash === expected.pathHash &&
        event.stateDigest === expected.stateDigest,
      spec.timeoutMs,
    );
    for (const machineId of targetIds) {
      const targetChange = await requiredObserver(observers, machineId).waitFor(
        (event) =>
          event.kind === "change" &&
          event.pathHash === expected.pathHash &&
          event.stateDigest === expected.stateDigest,
        spec.timeoutMs,
      );
      pathLatencies.push(
        Math.max(0, targetChange.receivedMs - sourceChange.receivedMs),
      );
    }
  }
  const allTargets = Math.max(...Object.values(targetTimes));
  const writerCompleteToTargets = Object.fromEntries(
    Object.entries(targetTimes).map(([machineId, receivedMs]) => [
      machineId,
      milliseconds(Math.max(0, receivedMs - writerCompletedMs)),
    ]),
  );
  return {
    firstSourceChangeMs: milliseconds(
      Math.max(0, firstSource.receivedMs - writerStartedMs),
    ),
    writerCompleteToHubMs: milliseconds(
      Math.max(0, hubAccepted.receivedMs - writerCompletedMs),
    ),
    writerCompleteToTargetsMs: writerCompleteToTargets,
    allTargetsConvergedMs: milliseconds(
      Math.max(0, allTargets - writerCompletedMs),
    ),
    pathVisibilityMs: percentiles(pathLatencies),
  };
}

class JsonLineProcess<Event> {
  readonly events: { readonly receivedMs: number; readonly event: Event }[] =
    [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #started: number;
  readonly #label: string;
  #stdout = "";
  #stderr = "";
  #stderrBytes = 0;
  #closed = false;
  #failure: Error | null = null;

  constructor(
    machineSpec: IsolatedMachineSpec,
    agent: "visibility-agent" | "hub-visibility-agent",
    request: unknown,
    controllerStarted: number,
  ) {
    const invocation = machineInvocation(machineSpec, agent);
    this.#started = controllerStarted;
    this.#label = `${machineSpec.machineId}:${agent}`;
    this.#child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: minimalEnvironment(),
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderr.length < 64 * 1024)
        this.#stderr += chunk.toString("utf8").slice(0, 64 * 1024);
      if (this.#stderrBytes > 1024 * 1024) this.#child.kill("SIGTERM");
    });
    this.#child.on("error", () => {
      this.#failure = new Error(`Observer could not start: ${this.#label}`);
    });
    this.#child.on("close", (status) => {
      this.#closed = true;
      if (status !== 0 && status !== null && this.#failure === null)
        this.#failure = new Error(
          `Observer failed: ${this.#label}: ${childFailureDetail(this.#stderr)}`,
        );
    });
    this.#child.stdin.end(`${JSON.stringify(request)}\n`);
  }

  async waitFor(
    predicate: (event: Event) => boolean,
    timeoutMs: number,
  ): Promise<{ readonly receivedMs: number; readonly event: Event }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.events.find((entry) => predicate(entry.event));
      if (match !== undefined) return match;
      if (this.#failure !== null) throw this.#failure;
      if (this.#closed)
        throw new Error(`Observer closed before its event: ${this.#label}`);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 10),
      );
    }
    throw new Error(`Observer timed out: ${this.#label}`);
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const forced = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolvePromise();
      }, 2_000);
      this.#child.once("close", () => {
        clearTimeout(forced);
        resolvePromise();
      });
    });
  }

  #onData(chunk: Buffer): void {
    this.#stdout += chunk.toString("utf8");
    if (this.#stdout.length > 16 * 1024 * 1024) {
      this.#failure = new Error(
        `Observer output exceeded limit: ${this.#label}`,
      );
      this.#child.kill("SIGTERM");
      return;
    }
    for (;;) {
      const newline = this.#stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      try {
        const event = JSON.parse(line) as Event;
        this.events.push({ receivedMs: elapsed(this.#started), event });
      } catch {
        this.#failure = new Error(
          `Observer returned invalid JSON: ${this.#label}`,
        );
        this.#child.kill("SIGTERM");
      }
    }
  }
}

function startJsonLineProcess<Event>(
  machineSpec: IsolatedMachineSpec,
  agent: "visibility-agent" | "hub-visibility-agent",
  request: unknown,
  controllerStarted: number,
): JsonLineProcess<Event> {
  return new JsonLineProcess<Event>(
    machineSpec,
    agent,
    request,
    controllerStarted,
  );
}

async function callIsolatedAgent(
  machineSpec: IsolatedMachineSpec,
  request: IsolatedAgentRequest,
): Promise<unknown> {
  const invocation = machineInvocation(machineSpec, "isolated-agent");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: minimalEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const count = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill("SIGTERM");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      count(chunk);
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      count(chunk);
      stderr.push(chunk);
    });
    child.on("error", () =>
      reject(
        new Error(`Isolated agent could not start: ${machineSpec.machineId}`),
      ),
    );
    child.on("close", (status) => {
      if (bytes > 64 * 1024 * 1024) {
        reject(
          new Error(
            `Isolated agent output exceeded limit: ${machineSpec.machineId}`,
          ),
        );
        return;
      }
      if (status !== 0) {
        reject(
          new Error(
            `Isolated agent failed: ${machineSpec.machineId}: ${childFailureDetail(Buffer.concat(stderr).toString("utf8"))}`,
          ),
        );
        return;
      }
      try {
        resolvePromise(
          JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown,
        );
      } catch {
        reject(
          new Error(
            `Isolated agent returned invalid JSON: ${machineSpec.machineId}`,
          ),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function childFailureDetail(stderr: string): string {
  const normalized = stderr.trim().replaceAll(/\s+/gu, " ");
  return normalized.length === 0
    ? "no stderr"
    : normalized.slice(Math.max(0, normalized.length - 4_096));
}

function machineInvocation(
  machineSpec: IsolatedMachineSpec,
  agent: string,
): { readonly command: string; readonly args: readonly string[] } {
  const localCommand = machineSpec.command[0];
  if (localCommand === undefined)
    throw new Error(`Isolated command is missing: ${machineSpec.machineId}`);
  const commandArgs = [...machineSpec.command.slice(1), agent];
  if (machineSpec.endpoint.kind === "local")
    return { command: localCommand, args: commandArgs };
  return {
    command: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      machineSpec.endpoint.sshAlias ?? "",
      [localCommand, ...commandArgs].map(shellQuote).join(" "),
    ],
  };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.XDG_RUNTIME_DIR === undefined
      ? {}
      : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
      ? {}
      : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
  };
}

function validateIsolatedSpec(spec: IsolatedFleetAcceptanceSpec): void {
  if (spec.schemaVersion !== 1 || spec.repetitions !== 2)
    throw new Error(
      "Isolated acceptance requires schema 1 and two repetitions",
    );
  safeId(spec.runId, "run ID");
  safeId(spec.scenarioId, "scenario ID");
  safeId(spec.aiWorkspaceName, "AI workspace name");
  if (!/^[a-f0-9]{64}$/u.test(spec.expectedReleaseSha256))
    throw new Error("Isolated expected release SHA-256 is invalid");
  if (!isAbsolute(spec.controllerStateDir))
    throw new Error("Isolated controller state must be absolute");
  if (spec.machines.length !== 3)
    throw new Error("Isolated acceptance requires exactly three machines");
  if (spec.targetOrder.length !== 2)
    throw new Error("Isolated acceptance requires exactly two targets");
  const ids = spec.machines.map((entry) => entry.machineId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Isolated machine IDs must be unique");
  if (!ids.includes(spec.sourceMachineId) || !ids.includes(spec.hubMachineId))
    throw new Error("Isolated source or hub machine is missing");
  const hubMachine = spec.machines.find(
    (entry) => entry.machineId === spec.hubMachineId,
  );
  if (
    hubMachine === undefined ||
    resolve(spec.controllerStateDir) !== resolve(hubMachine.runRoot)
  )
    throw new Error(
      "Isolated controller state must use the hub machine run root",
    );
  if (
    new Set(spec.targetOrder).size !== spec.targetOrder.length ||
    spec.targetOrder.includes(spec.sourceMachineId) ||
    spec.targetOrder.some((id) => !ids.includes(id))
  )
    throw new Error("Isolated target order is invalid");
  if (!spec.targetOrder.includes(spec.hubMachineId))
    throw new Error("Isolated hub must also be a populated target");
  if (
    hubMachine.endpoint.kind !== "local" ||
    spec.machines.filter((entry) => entry.endpoint.kind === "local").length !==
      1
  )
    throw new Error(
      "Isolated controller must invoke only the hub machine locally",
    );
  for (const entry of spec.machines) {
    safeId(entry.machineId, "machine ID");
    safeId(entry.peerName, "peer name");
    if (!isAbsolute(entry.runRoot) || !isAbsolute(entry.masterRoot))
      throw new Error("Isolated machine roots must be absolute");
    const runRoot = resolve(entry.runRoot);
    const masterRoot = resolve(entry.masterRoot);
    if (
      runRoot === masterRoot ||
      runRoot.startsWith(`${masterRoot}${sep}`) ||
      masterRoot.startsWith(`${runRoot}${sep}`)
    )
      throw new Error("Isolated master and run roots must not overlap");
    if (entry.command.length === 0)
      throw new Error("Isolated machine command is missing");
    if (!isAbsolute(entry.command[0] ?? ""))
      throw new Error("Isolated machine command must be absolute");
    if (!/^[A-Za-z0-9_.@:-]+$/u.test(entry.sshAlias))
      throw new Error("Isolated canonical SSH alias is invalid");
    if (entry.endpoint.kind === "ssh") {
      if (entry.endpoint.sshAlias !== entry.sshAlias)
        throw new Error("Isolated SSH alias is invalid");
    } else if (entry.endpoint.sshAlias !== undefined) {
      throw new Error("Isolated local endpoint cannot name an SSH alias");
    }
  }
  if (spec.aiWriterCommand.length === 0 || spec.aiModelId.trim().length === 0)
    throw new Error("Isolated AI writer command and model ID are required");
  if (spec.aiPrompt !== aiWorkloadPrompt)
    throw new Error("Isolated AI prompt does not match the accepted prompt");
  if (
    !Number.isInteger(spec.observerPollIntervalMs) ||
    spec.observerPollIntervalMs < 10 ||
    !Number.isInteger(spec.timeoutMs) ||
    spec.timeoutMs < 30_000
  )
    throw new Error("Isolated timing configuration is invalid");
}

function assertIsolatedSpec(
  value: unknown,
): asserts value is IsolatedFleetAcceptanceSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated acceptance specification must be an object");
  validateIsolatedSpec(value as IsolatedFleetAcceptanceSpec);
}

function isolatedAgentRequest(value: unknown): IsolatedAgentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated agent request must be an object");
  const action = (value as { readonly action?: unknown }).action;
  if (
    action !== "prepare" &&
    action !== "ssh-matrix" &&
    action !== "ai-writer" &&
    action !== "ai-replay" &&
    action !== "capacity" &&
    action !== "service" &&
    action !== "semantic" &&
    action !== "verify"
  )
    throw new Error("Isolated agent action is invalid");
  return value as IsolatedAgentRequest;
}

function hubVisibilitySpec(value: unknown): HubVisibilityObserverSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Hub visibility specification must be an object");
  const spec = value as HubVisibilityObserverSpec;
  if (
    spec.schemaVersion !== 1 ||
    !Number.isInteger(spec.pollIntervalMs) ||
    spec.pollIntervalMs < 10 ||
    !Number.isInteger(spec.timeoutMs) ||
    spec.timeoutMs < 1_000
  )
    throw new Error("Hub visibility specification is invalid");
  return spec;
}

function assertRunBoundary(
  repetitionId: string,
  repetitionRoot: string,
  target: string,
): void {
  assertExactSentinel(repetitionRoot, repetitionId);
  assertDescendant(repetitionRoot, target);
}

function assertExactSentinel(root: string, runId: string): void {
  const sentinel = join(resolve(root), "SENTINEL");
  if (!existsSync(sentinel) || readFileSync(sentinel, "utf8").trim() !== runId)
    throw new Error("Isolated run sentinel does not match");
}

function assertDescendant(root: string, target: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!absoluteTarget.startsWith(`${absoluteRoot}${sep}`))
    throw new Error("Isolated target escapes its run root");
}

function atomicPrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function machine(
  spec: IsolatedFleetAcceptanceSpec,
  machineId: string,
): IsolatedMachineSpec {
  const result = spec.machines.find((entry) => entry.machineId === machineId);
  if (result === undefined)
    throw new Error(`Isolated machine is missing: ${machineId}`);
  return result;
}

function requiredLayout(
  layouts: ReadonlyMap<string, MachineLayout>,
  machineId: string,
): MachineLayout {
  const layout = layouts.get(machineId);
  if (layout === undefined)
    throw new Error(`Isolated machine layout is missing: ${machineId}`);
  return layout;
}

function requiredObserver(
  observers: ReadonlyMap<string, JsonLineProcess<VisibilityEvent>>,
  machineId: string,
): JsonLineProcess<VisibilityEvent> {
  const observer = observers.get(machineId);
  if (observer === undefined)
    throw new Error(`Isolated observer is missing: ${machineId}`);
  return observer;
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`Isolated ${label} is invalid`);
}

function aiWriterResult(value: unknown): AiWriterResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated AI writer result is invalid");
  const result = value as AiWriterResult;
  if (
    result.passed !== true ||
    typeof result.finalDigest !== "string" ||
    !Array.isArray(result.finalPathStates)
  )
    throw new Error("Isolated AI writer result is invalid");
  return result;
}

function semanticResultValue(value: unknown): SemanticResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated semantic result is invalid");
  const result = value as SemanticResult;
  if (typeof result.digest !== "string" || typeof result.entries !== "number")
    throw new Error("Isolated semantic result is invalid");
  return result;
}

function syncSummary(value: unknown): SyncSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated sync result is invalid");
  return value as SyncSummary;
}

function serviceStatusResult(value: unknown): ServiceStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Isolated service result is invalid");
  const status = value as ServiceStatus;
  if (
    typeof status.installed !== "boolean" ||
    typeof status.running !== "boolean"
  )
    throw new Error("Isolated service result is invalid");
  return status;
}

function percentiles(values: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
  readonly maximum: number;
} {
  if (values.length === 0) throw new Error("Visibility timings are empty");
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: milliseconds(percentile(sorted, 0.5)),
    p95: milliseconds(percentile(sorted, 0.95)),
    maximum: milliseconds(sorted.at(-1) ?? 0),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(values.length * quantile) - 1);
  return values[index] ?? 0;
}

function elapsed(started: number): number {
  return milliseconds(performance.now() - started);
}

function milliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
