import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  peerNames,
  type HarnessConfig,
  type PeerConfig,
  type PeerName,
} from "./types.js";

export function loadConfig(path: string): HarnessConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }
  const value = raw as Record<string, unknown>;
  const peersRaw = value.peers;
  if (!Array.isArray(peersRaw))
    throw new Error("Config peers must be an array");
  const peers = peersRaw.map(parsePeer);
  const names = new Set(peers.map((peer) => peer.name));
  if (peers.length !== 3 || peerNames.some((name) => !names.has(name))) {
    throw new Error("Config must contain exactly alpha, beta, and gamma");
  }
  return {
    quietSamples: positiveInteger(value.quietSamples, "quietSamples"),
    quietIntervalMs: positiveInteger(value.quietIntervalMs, "quietIntervalMs"),
    convergenceTimeoutMs: positiveInteger(
      value.convergenceTimeoutMs,
      "convergenceTimeoutMs",
    ),
    peers,
  };
}

function parsePeer(input: unknown, index: number): PeerConfig {
  if (typeof input !== "object" || input === null)
    throw new Error(`Peer ${index} must be an object`);
  const value = input as Record<string, unknown>;
  if (
    typeof value.name !== "string" ||
    !peerNames.includes(value.name as PeerName)
  )
    throw new Error(`Peer ${index} has an invalid name`);
  if (typeof value.host !== "string" || value.host.length === 0)
    throw new Error(`Peer ${value.name} has an invalid host`);
  if (typeof value.runBase !== "string" || !isAbsolute(value.runBase))
    throw new Error(`Peer ${value.name} runBase must be absolute`);
  if (
    typeof value.treesyncBinary !== "string" ||
    !isAbsolute(value.treesyncBinary)
  )
    throw new Error(`Peer ${value.name} treesyncBinary must be absolute`);
  if (typeof value.nodeBinary !== "string" || !isAbsolute(value.nodeBinary))
    throw new Error(`Peer ${value.name} nodeBinary must be absolute`);
  return {
    name: value.name as PeerName,
    host: value.host,
    runBase: value.runBase,
    treesyncBinary: value.treesyncBinary,
    nodeBinary: value.nodeBinary,
  };
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
