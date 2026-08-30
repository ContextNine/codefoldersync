import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { canonicalJson } from "../v2/hash.js";
import { productVersion } from "../v2/service.js";
import { shellQuote } from "../executor.js";
import {
  loadConfig,
  type PeerEnrollmentRequest,
  verifyConfig,
} from "./config.js";
import {
  applyAdoptionV3,
  cutoverAdoptionV3,
  planAdoptionV3,
  sealSourceV3,
  verifyFullV3,
} from "./engine.js";
import {
  type DistributedBuildIdentity,
  type DistributedExecutor,
  type DistributedMachineSpec,
  type DistributedTargetSpec,
} from "./distributed.js";
import { installedReleaseIdentity } from "./release.js";
import {
  activatePeerV3,
  enrollPeerV3,
  preparePeerEnrollment,
  readEnrollmentRequest,
  setupAuthorityV3,
} from "./setup.js";
import {
  protocolVersion,
  schemaVersion,
  type AdoptionPlan,
  type HubConfig,
  type ProductConfig,
  type SyncSummary,
} from "./types.js";

interface ConfigExpectation {
  readonly folderId: string;
  readonly peerId: string;
  readonly revision: number;
}

type AgentRequest =
  | { readonly action: "inspect" }
  | {
      readonly action: "setup-authority";
      readonly root: string;
      readonly stateDir: string;
      readonly configPath: string;
      readonly peerName: string;
      readonly folderName: string;
      readonly backupWitness: string;
      readonly hub: HubConfig;
    }
  | {
      readonly action: "prepare-enrollment";
      readonly acceptedConfig: ProductConfig;
      readonly root: string;
      readonly stateDir: string;
      readonly requestPath: string;
      readonly peerName: string;
      readonly role: "peer" | "hub";
    }
  | {
      readonly action: "enroll-peer";
      readonly configPath: string;
      readonly request: PeerEnrollmentRequest;
    }
  | {
      readonly action: "activate-peer";
      readonly acceptedConfig: ProductConfig;
      readonly request: PeerEnrollmentRequest;
      readonly stateDir: string;
      readonly configPath: string;
    }
  | {
      readonly action: "seal-source" | "verify";
      readonly configPath: string;
      readonly expected: ConfigExpectation;
    }
  | {
      readonly action: "cutover";
      readonly configPath: string;
      readonly expected: ConfigExpectation;
    }
  | {
      readonly action: "plan-adoption" | "apply-adoption";
      readonly configPath: string;
      readonly expected: ConfigExpectation;
      readonly adoptionId: string;
    };

export class ProcessDistributedExecutor implements DistributedExecutor {
  public async inspect(
    machine: DistributedMachineSpec,
  ): Promise<DistributedBuildIdentity> {
    return buildIdentity(await callAgent(machine, { action: "inspect" }));
  }

  public async setupAuthority(
    machine: DistributedMachineSpec,
    input: {
      readonly folderName: string;
      readonly backupWitness: string;
      readonly hub: HubConfig;
    },
  ): Promise<ProductConfig> {
    return productConfig(
      await callAgent(machine, {
        action: "setup-authority",
        root: machine.root,
        stateDir: machine.stateDir,
        configPath: machine.configPath,
        peerName: machine.peerName,
        ...input,
      }),
    );
  }

  public async prepareEnrollment(
    machine: DistributedTargetSpec,
    acceptedConfig: ProductConfig,
  ): Promise<PeerEnrollmentRequest> {
    return enrollmentRequest(
      await callAgent(machine, {
        action: "prepare-enrollment",
        acceptedConfig,
        root: machine.root,
        stateDir: machine.stateDir,
        requestPath: machine.requestPath,
        peerName: machine.peerName,
        role: machine.role,
      }),
    );
  }

  public async enrollPeer(
    machine: DistributedMachineSpec,
    request: PeerEnrollmentRequest,
  ): Promise<ProductConfig> {
    return productConfig(
      await callAgent(machine, {
        action: "enroll-peer",
        configPath: machine.configPath,
        request,
      }),
    );
  }

  public async activatePeer(
    machine: DistributedTargetSpec,
    acceptedConfig: ProductConfig,
    request: PeerEnrollmentRequest,
  ): Promise<ProductConfig> {
    return productConfig(
      await callAgent(machine, {
        action: "activate-peer",
        acceptedConfig,
        request,
        stateDir: machine.stateDir,
        configPath: machine.configPath,
      }),
    );
  }

  public async sealSource(
    machine: DistributedMachineSpec,
    config: ProductConfig,
  ): Promise<SyncSummary> {
    return syncSummary(
      await callAgent(machine, {
        action: "seal-source",
        configPath: machine.configPath,
        expected: expectation(config),
      }),
    );
  }

  public async planAdoption(
    machine: DistributedTargetSpec,
    config: ProductConfig,
    adoptionId: string,
  ): Promise<AdoptionPlan> {
    return adoptionPlan(
      await callAgent(machine, {
        action: "plan-adoption",
        configPath: machine.configPath,
        expected: expectation(config),
        adoptionId,
      }),
    );
  }

  public async applyAdoption(
    machine: DistributedTargetSpec,
    config: ProductConfig,
    adoptionId: string,
  ): Promise<SyncSummary> {
    return syncSummary(
      await callAgent(machine, {
        action: "apply-adoption",
        configPath: machine.configPath,
        expected: expectation(config),
        adoptionId,
      }),
    );
  }

  public async verify(
    machine: DistributedMachineSpec,
    config: ProductConfig,
  ): Promise<SyncSummary> {
    return syncSummary(
      await callAgent(machine, {
        action: "verify",
        configPath: machine.configPath,
        expected: expectation(config),
      }),
    );
  }

  public async cutover(
    machine: DistributedMachineSpec,
    config: ProductConfig,
  ): Promise<ProductConfig> {
    return productConfig(
      await callAgent(machine, {
        action: "cutover",
        configPath: machine.configPath,
        expected: expectation(config),
      }),
    );
  }
}

export async function runDistributedAgent(request: unknown): Promise<unknown> {
  const input = agentRequest(request);
  switch (input.action) {
    case "inspect": {
      const release = installedReleaseIdentity();
      return {
        version: productVersion,
        schemaVersion,
        protocolVersion,
        releaseSha256: release?.archiveSha256 ?? null,
      } satisfies DistributedBuildIdentity;
    }
    case "setup-authority":
      return (
        await setupAuthorityV3({
          root: input.root,
          stateDir: input.stateDir,
          configPath: input.configPath,
          peerName: input.peerName,
          folderName: input.folderName,
          backupWitness: input.backupWitness,
          hub: input.hub,
        })
      ).config;
    case "prepare-enrollment": {
      if (existsSync(input.requestPath)) {
        const existing = readEnrollmentRequest(input.requestPath);
        if (
          existing.folderId !== input.acceptedConfig.folderId ||
          existing.peer.peerName !== input.peerName ||
          existing.peer.root !== input.root ||
          existing.peer.role !== input.role
        )
          throw new Error("Existing enrollment request does not match");
        return existing;
      }
      return preparePeerEnrollment({
        acceptedConfig: input.acceptedConfig,
        root: input.root,
        stateDir: input.stateDir,
        requestPath: input.requestPath,
        peerName: input.peerName,
        role: input.role,
      });
    }
    case "enroll-peer": {
      const authority = loadConfig(input.configPath);
      const existing = authority.peers.find(
        (peer) => peer.peerId === input.request.peer.peerId,
      );
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(input.request.peer))
          throw new Error("Existing peer differs from enrollment request");
        return authority;
      }
      return enrollPeerV3({
        authorityConfig: authority,
        authorityConfigPath: input.configPath,
        request: input.request,
      });
    }
    case "activate-peer":
      return activatePeerV3({
        acceptedConfig: input.acceptedConfig,
        request: input.request,
        stateDir: input.stateDir,
        configPath: input.configPath,
      });
    case "seal-source": {
      const config = expectedLocalConfig(input.configPath, input.expected);
      return sealSourceV3(config);
    }
    case "plan-adoption": {
      const config = expectedLocalConfig(input.configPath, input.expected);
      return planAdoptionV3(config, { adoptionId: input.adoptionId });
    }
    case "apply-adoption": {
      const config = expectedLocalConfig(input.configPath, input.expected);
      return applyAdoptionV3(config, input.adoptionId);
    }
    case "verify": {
      const config = expectedLocalConfig(input.configPath, input.expected);
      return verifyFullV3(config);
    }
    case "cutover": {
      const current = loadConfig(input.configPath);
      if (
        current.folderId === input.expected.folderId &&
        current.peerId === input.expected.peerId &&
        current.revision === input.expected.revision + 1 &&
        current.lifecycle === "normal"
      )
        return current;
      const config = expectedLocalConfig(input.configPath, input.expected);
      return cutoverAdoptionV3(config, input.configPath);
    }
  }
}

async function callAgent(
  machine: DistributedMachineSpec,
  request: AgentRequest,
): Promise<unknown> {
  const localCommand = machine.command[0];
  if (localCommand === undefined)
    throw new Error(`Distributed command is missing: ${machine.machineId}`);
  const commandArgs = [...machine.command.slice(1), "distributed-agent"];
  const command = machine.endpoint.kind === "local" ? localCommand : "ssh";
  const args =
    machine.endpoint.kind === "local"
      ? commandArgs
      : [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "ConnectTimeout=10",
          machine.endpoint.sshAlias ?? "",
          [localCommand, ...commandArgs].map(shellQuote).join(" "),
        ];
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C.UTF-8",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (destination: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () =>
      reject(
        new Error(`Distributed agent could not start: ${machine.machineId}`),
      ),
    );
    child.on("close", (status) => {
      if (bytes > 64 * 1024 * 1024) {
        reject(
          new Error(
            `Distributed agent output exceeded limit: ${machine.machineId}`,
          ),
        );
        return;
      }
      if (status !== 0) {
        reject(
          new Error(
            `Distributed agent failed on ${machine.machineId}: ${request.action}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown);
      } catch {
        reject(
          new Error(
            `Distributed agent returned invalid JSON: ${machine.machineId}`,
          ),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function expectedLocalConfig(
  configPath: string,
  expected: ConfigExpectation,
): ProductConfig {
  const config = loadConfig(configPath);
  if (
    config.folderId !== expected.folderId ||
    config.peerId !== expected.peerId ||
    config.revision !== expected.revision
  )
    throw new Error("Local configuration differs from controller expectation");
  return config;
}

function expectation(config: ProductConfig): ConfigExpectation {
  return {
    folderId: config.folderId,
    peerId: config.peerId,
    revision: config.revision,
  };
}

function agentRequest(value: unknown): AgentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Distributed agent request must be an object");
  const action = (value as Record<string, unknown>).action;
  if (
    action !== "inspect" &&
    action !== "setup-authority" &&
    action !== "prepare-enrollment" &&
    action !== "enroll-peer" &&
    action !== "activate-peer" &&
    action !== "seal-source" &&
    action !== "plan-adoption" &&
    action !== "apply-adoption" &&
    action !== "verify" &&
    action !== "cutover"
  )
    throw new Error("Distributed agent action is invalid");
  return value as AgentRequest;
}

function buildIdentity(value: unknown): DistributedBuildIdentity {
  const record = object(value, "build identity");
  if (
    typeof record.version !== "string" ||
    typeof record.schemaVersion !== "number" ||
    typeof record.protocolVersion !== "number" ||
    (record.releaseSha256 !== null && typeof record.releaseSha256 !== "string")
  )
    throw new Error("Distributed build identity is invalid");
  return {
    version: record.version,
    schemaVersion: record.schemaVersion,
    protocolVersion: record.protocolVersion,
    releaseSha256: record.releaseSha256,
  };
}

function productConfig(value: unknown): ProductConfig {
  const config = value as ProductConfig;
  verifyConfig(config);
  return config;
}

function enrollmentRequest(value: unknown): PeerEnrollmentRequest {
  const record = object(value, "enrollment request");
  if (
    typeof record.folderId !== "string" ||
    typeof record.signature !== "string" ||
    typeof record.peer !== "object" ||
    record.peer === null
  )
    throw new Error("Distributed enrollment request is invalid");
  return value as PeerEnrollmentRequest;
}

function adoptionPlan(value: unknown): AdoptionPlan {
  const record = object(value, "adoption plan");
  if (
    typeof record.adoptionId !== "string" ||
    typeof record.folderId !== "string" ||
    typeof record.targetPeerId !== "string"
  )
    throw new Error("Distributed adoption plan is invalid");
  return value as AdoptionPlan;
}

function syncSummary(value: unknown): SyncSummary {
  const record = object(value, "sync summary");
  if (
    record.status !== "clean" &&
    record.status !== "conflict" &&
    record.status !== "offline" &&
    record.status !== "inconclusive"
  )
    throw new Error("Distributed sync summary is invalid");
  return value as SyncSummary;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Distributed ${name} must be an object`);
  return value as Record<string, unknown>;
}
