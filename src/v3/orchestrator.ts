import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultConfigPath, parseHubSpec } from "./config.js";
import { applyAdoptionV3, planAdoptionV3, sealSourceV3 } from "./engine.js";
import {
  activatePeerV3,
  enrollPeerV3,
  preparePeerEnrollment,
  setupAuthorityV3,
} from "./setup.js";
import type { HubConfig, ProductConfig, SyncSummary } from "./types.js";

export interface FleetSetupPeerSpec {
  readonly peerName: string;
  readonly root: string;
  readonly stateDir: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly role?: "peer" | "hub";
}

export interface FleetSetupSpec {
  readonly folderName: string;
  readonly backupWitness: string;
  readonly hub: HubConfig;
  readonly authority: {
    readonly peerName: string;
    readonly root: string;
    readonly stateDir: string;
    readonly configPath: string;
  };
  readonly targets: readonly FleetSetupPeerSpec[];
}

export interface FleetSetupResult {
  readonly authority: ProductConfig;
  readonly sourceSeal: SyncSummary;
  readonly targets: readonly {
    readonly config: ProductConfig;
    readonly adoptionId: string;
    readonly result: SyncSummary;
  }[];
  readonly lifecycle: "adoption";
  readonly cutoverReady: boolean;
  readonly servicesEnabled: false;
}

export type SetupQuestion = (prompt: string) => Promise<string>;

/** Collects the same populated-fleet specification accepted by --mode fleet. */
export async function promptFleetSetupSpecV3(
  question: SetupQuestion,
  localPeerName = hostname(),
): Promise<FleetSetupSpec> {
  const folderName = await answer(question, "Folder name", "code");
  const backupWitness = await answer(
    question,
    "Verified encrypted backup witness ID",
  );
  const hubValue = await answer(
    question,
    "Hub path or ssh://user@host/absolute/path",
  );
  const authorityRoot = resolve(
    await answer(question, "Source authority Code folder path"),
  );
  const authorityPeerName = await answer(
    question,
    "Source authority machine",
    localPeerName,
  );
  const authorityStateDir = resolve(
    await answer(
      question,
      "Source authority state path",
      interactiveStatePath(authorityRoot),
    ),
  );
  const authorityConfigPath = resolve(
    await answer(
      question,
      "Source authority config path",
      defaultConfigPath(authorityRoot),
    ),
  );
  const targetCountValue = await answer(question, "Populated target count");
  const targetCount = Number(targetCountValue);
  if (!Number.isSafeInteger(targetCount) || targetCount < 1)
    throw new Error("Populated target count must be a positive integer");

  const targets: FleetSetupPeerSpec[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const label = `Target ${index + 1}`;
    const root = resolve(await answer(question, `${label} Code folder path`));
    const stateDir = resolve(
      await answer(question, `${label} state path`, interactiveStatePath(root)),
    );
    const roleValue = await answer(question, `${label} role`, "peer");
    if (roleValue !== "peer" && roleValue !== "hub")
      throw new Error(`${label} role must be peer or hub`);
    targets.push({
      peerName: await answer(question, `${label} machine`),
      root,
      stateDir,
      configPath: resolve(
        await answer(question, `${label} config path`, defaultConfigPath(root)),
      ),
      requestPath: resolve(
        await answer(
          question,
          `${label} enrollment request path`,
          join(stateDir, "enrollment-request.json"),
        ),
      ),
      role: roleValue,
    });
  }

  const spec: FleetSetupSpec = {
    folderName,
    backupWitness,
    hub: parseHubSpec(hubValue),
    authority: {
      peerName: authorityPeerName,
      root: authorityRoot,
      stateDir: authorityStateDir,
      configPath: authorityConfigPath,
    },
    targets,
  };
  validateFleetSpec(spec);
  const confirmation = (
    await question(
      `Seal ${authorityRoot}, adopt ${targetCount} populated target${targetCount === 1 ? "" : "s"}, and leave services disabled? [yes/no] `,
    )
  )
    .trim()
    .toLowerCase();
  if (confirmation !== "yes" && confirmation !== "y")
    throw new Error("Setup cancelled");
  return spec;
}

/** Runs the terminal form of the populated-fleet setup ceremony. */
export async function interactiveFleetSetupV3(): Promise<FleetSetupResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Interactive setup requires a terminal; use --mode fleet --spec for automation",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const spec = await promptFleetSetupSpecV3((message) =>
      prompt.question(message),
    );
    return setupPopulatedFleetV3(spec);
  } finally {
    prompt.close();
  }
}

/** Runs the scriptable single-host form of the populated-fleet setup ceremony. */
export async function setupPopulatedFleetV3(
  spec: FleetSetupSpec,
): Promise<FleetSetupResult> {
  validateFleetSpec(spec);
  let authority = (
    await setupAuthorityV3({
      root: spec.authority.root,
      stateDir: spec.authority.stateDir,
      folderName: spec.folderName,
      peerName: spec.authority.peerName,
      configPath: spec.authority.configPath,
      hub: spec.hub,
      backupWitness: spec.backupWitness,
    })
  ).config;
  const prepared = [];
  for (const target of spec.targets) {
    const request = preparePeerEnrollment({
      acceptedConfig: authority,
      root: target.root,
      stateDir: target.stateDir,
      peerName: target.peerName,
      requestPath: target.requestPath,
      ...(target.role === undefined ? {} : { role: target.role }),
    });
    authority = await enrollPeerV3({
      authorityConfig: authority,
      authorityConfigPath: spec.authority.configPath,
      request,
    });
    prepared.push({ target, request });
  }
  const targets = prepared.map(({ target, request }) => ({
    target,
    request,
    config: activatePeerV3({
      acceptedConfig: authority,
      request,
      stateDir: target.stateDir,
      configPath: target.configPath,
    }),
  }));
  const sourceSeal = await sealSourceV3(authority);
  const adopted = [];
  for (const target of targets) {
    const plan = await planAdoptionV3(target.config);
    const result = await applyAdoptionV3(target.config, plan.adoptionId);
    adopted.push({
      config: target.config,
      adoptionId: plan.adoptionId,
      result,
    });
  }
  return {
    authority,
    sourceSeal,
    targets: adopted,
    lifecycle: "adoption",
    cutoverReady: adopted.every(
      ({ result }) => result.status === "clean" || result.status === "conflict",
    ),
    servicesEnabled: false,
  };
}

export function readFleetSetupSpec(path: string): FleetSetupSpec {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null)
    throw new Error("Fleet setup specification must be an object");
  const input = value as Record<string, unknown>;
  const authority = record(input.authority, "authority");
  const targets = input.targets;
  if (!Array.isArray(targets))
    throw new Error("Fleet setup targets must be an array");
  const hub = record(input.hub, "hub");
  const hubConfig =
    hub.kind === "local" && typeof hub.path === "string"
      ? ({ kind: "local", path: hub.path } as const)
      : hub.kind === "ssh" &&
          typeof hub.host === "string" &&
          typeof hub.path === "string" &&
          Array.isArray(hub.command) &&
          hub.command.every((item) => typeof item === "string")
        ? ({
            kind: "ssh",
            host: hub.host,
            path: hub.path,
            command: hub.command,
          } as const)
        : null;
  if (hubConfig === null) throw new Error("Fleet setup hub is invalid");
  return {
    folderName: string(input.folderName, "folderName"),
    backupWitness: string(input.backupWitness, "backupWitness"),
    hub: hubConfig,
    authority: {
      peerName: string(authority.peerName, "authority.peerName"),
      root: string(authority.root, "authority.root"),
      stateDir: string(authority.stateDir, "authority.stateDir"),
      configPath: string(authority.configPath, "authority.configPath"),
    },
    targets: targets.map((target, index) => {
      const peer = record(target, `targets[${index}]`);
      const role = peer.role;
      if (role !== undefined && role !== "peer" && role !== "hub")
        throw new Error(`targets[${index}].role is invalid`);
      return {
        peerName: string(peer.peerName, `targets[${index}].peerName`),
        root: string(peer.root, `targets[${index}].root`),
        stateDir: string(peer.stateDir, `targets[${index}].stateDir`),
        configPath: string(peer.configPath, `targets[${index}].configPath`),
        requestPath: string(peer.requestPath, `targets[${index}].requestPath`),
        ...(role === undefined ? {} : { role }),
      };
    }),
  };
}

function validateFleetSpec(spec: FleetSetupSpec): void {
  if (spec.backupWitness.trim().length === 0)
    throw new Error("Fleet setup requires a verified backup witness");
  if (spec.targets.length === 0)
    throw new Error("Fleet setup requires at least one target");
  const names = [
    spec.authority.peerName,
    ...spec.targets.map((target) => target.peerName),
  ];
  if (new Set(names).size !== names.length)
    throw new Error("Fleet setup peer names must be unique");
  const roots = [
    spec.authority.root,
    ...spec.targets.map((target) => target.root),
  ].map((path) => resolve(path));
  if (new Set(roots).size !== roots.length)
    throw new Error("Fleet setup roots must be distinct");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function answer(
  question: SetupQuestion,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
  const value = (await question(`${label}${suffix}`)).trim();
  const resolved = value || defaultValue;
  if (resolved === undefined || resolved.trim().length === 0)
    throw new Error(`${label} is required`);
  return resolved;
}

function interactiveStatePath(root: string): string {
  return join(dirname(root), `.${basename(root)}.codefoldersync-state`);
}
