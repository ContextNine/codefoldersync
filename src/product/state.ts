import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./io.js";
import {
  productSchemaVersion,
  type BlockedUnit,
  type ClientState,
  type ProductConfig,
  type UnitState,
} from "./types.js";
import { assertSnapshotId } from "./validation.js";

export function loadClientState(config: ProductConfig): ClientState {
  const path = statePath(config);
  if (!existsSync(path)) {
    return {
      schemaVersion: productSchemaVersion,
      folderId: config.folderId,
      peerId: config.peerId,
      units: Object.fromEntries(config.units.map((unit) => [unit, {}])),
    };
  }
  const input = record(readJson(path), "Client state");
  if (
    input.schemaVersion !== productSchemaVersion ||
    input.folderId !== config.folderId ||
    input.peerId !== config.peerId
  ) {
    throw new Error("Client state does not match configuration");
  }
  const rawUnits = record(input.units, "Client units");
  const units: Record<string, UnitState> = {};
  for (const unit of config.units) units[unit] = parseUnitState(rawUnits[unit]);
  return {
    schemaVersion: productSchemaVersion,
    folderId: config.folderId,
    peerId: config.peerId,
    units,
  };
}

export function saveClientState(
  config: ProductConfig,
  state: ClientState,
): void {
  if (state.folderId !== config.folderId || state.peerId !== config.peerId) {
    throw new Error("Refusing to save mismatched client state");
  }
  writeJsonAtomic(statePath(config), state);
}

export function replaceUnitState(
  state: ClientState,
  unit: string,
  value: UnitState,
): ClientState {
  return { ...state, units: { ...state.units, [unit]: value } };
}

function parseUnitState(value: unknown): UnitState {
  if (value === undefined) return {};
  const input = record(value, "Unit state");
  const baselineId = optionalString(input.baselineId, "Baseline ID");
  const baselineDigest = optionalString(
    input.baselineDigest,
    "Baseline digest",
  );
  if (baselineId !== undefined) assertSnapshotId(baselineId, "Baseline ID");
  if (baselineDigest !== undefined && !/^[a-f0-9]{64}$/.test(baselineDigest)) {
    throw new Error("Baseline digest is invalid");
  }
  const blocked =
    input.blocked === undefined ? undefined : parseBlocked(input.blocked);
  return {
    ...(baselineId === undefined ? {} : { baselineId }),
    ...(baselineDigest === undefined ? {} : { baselineDigest }),
    ...(blocked === undefined ? {} : { blocked }),
  };
}

function parseBlocked(value: unknown): BlockedUnit {
  const input = record(value, "Blocked unit");
  const baseline = input.baselineId;
  if (baseline !== null && typeof baseline !== "string") {
    throw new Error("Blocked baseline is invalid");
  }
  const localSnapshotId = requiredString(
    input.localSnapshotId,
    "Local snapshot ID",
  );
  const remoteSnapshotId = requiredString(
    input.remoteSnapshotId,
    "Remote snapshot ID",
  );
  assertSnapshotId(localSnapshotId, "Local snapshot ID");
  assertSnapshotId(remoteSnapshotId, "Remote snapshot ID");
  return {
    baselineId: baseline,
    localSnapshotId,
    remoteSnapshotId,
    detectedAt: requiredString(input.detectedAt, "Detection time"),
  };
}

function statePath(config: ProductConfig): string {
  return join(config.stateDir, "state.json");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
