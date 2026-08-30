import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProcessDistributedExecutor } from "../src/v3/distributed-process.js";
import type { DistributedMachineSpec } from "../src/v3/distributed.js";

interface Spec {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly machineId: string;
  readonly sshAlias: string;
  readonly command: readonly string[];
  readonly root: string;
  readonly stateDir: string;
  readonly configPath: string;
  readonly hubPath: string;
  readonly expectedVersion: string;
  readonly expectedReleaseSha256: string;
}

const specPath = process.argv[2];
if (specPath === undefined)
  throw new Error("Usage: real-ssh-response-loss.ts <private-spec.json>");
const spec = parseSpec(JSON.parse(readFileSync(resolve(specPath), "utf8")));
const machine: DistributedMachineSpec = {
  machineId: spec.machineId,
  peerName: spec.machineId,
  endpoint: { kind: "ssh", sshAlias: spec.sshAlias },
  command: spec.command,
  root: spec.root,
  stateDir: spec.stateDir,
  configPath: spec.configPath,
};
const executor = new ProcessDistributedExecutor();
const build = await executor.inspect(machine);
assert.equal(build.version, spec.expectedVersion);
assert.equal(build.schemaVersion, 3);
assert.equal(build.protocolVersion, 3);
assert.equal(build.releaseSha256, spec.expectedReleaseSha256);
const setupInput = {
  folderName: spec.runId,
  backupWitness: "verified-real-ssh-response-loss",
  hub: { kind: "local" as const, path: spec.hubPath },
};
await assert.rejects(
  executor.setupAuthority(machine, setupInput),
  /Distributed agent failed/u,
);
const resumed = await executor.setupAuthority(machine, setupInput);
const repeated = await executor.setupAuthority(machine, setupInput);
assert.deepEqual(repeated, resumed);
const sealed = await executor.sealSource(machine, resumed);
assert.equal(sealed.status, "clean");
const verified = await executor.verify(machine, resumed);
assert.equal(verified.status, "clean");
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    runId: spec.runId,
    machineId: spec.machineId,
    exactBuild: true,
    realSshResponseLost: true,
    stableFolderIdentity: repeated.folderId === resumed.folderId,
    stablePeerIdentity: repeated.peerId === resumed.peerId,
    sealStatus: sealed.status,
    verifyStatus: verified.status,
    hubSequence: verified.hubSequence,
  })}\n`,
);

function parseSpec(value: unknown): Spec {
  if (typeof value !== "object" || value === null)
    throw new Error("SSH response-loss spec must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.runId !== "string" ||
    typeof input.machineId !== "string" ||
    typeof input.sshAlias !== "string" ||
    !Array.isArray(input.command) ||
    input.command.length === 0 ||
    input.command.some(
      (part) => typeof part !== "string" || part.length === 0,
    ) ||
    typeof input.root !== "string" ||
    typeof input.stateDir !== "string" ||
    typeof input.configPath !== "string" ||
    typeof input.hubPath !== "string" ||
    typeof input.expectedVersion !== "string" ||
    typeof input.expectedReleaseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.expectedReleaseSha256)
  )
    throw new Error("SSH response-loss spec is invalid");
  return input as unknown as Spec;
}
