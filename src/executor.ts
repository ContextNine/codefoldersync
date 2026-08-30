import type { PeerConfig } from "./types.js";
import { runCommand, runCommandAsync, type CommandResult } from "./process.js";

export function runOnPeer(
  peer: PeerConfig,
  command: string,
  args: readonly string[],
  allowFailure = false,
): CommandResult {
  if (peer.host === "local") {
    return runCommand(command, args, { allowFailure });
  }
  const remoteCommand = [command, ...args].map(shellQuote).join(" ");
  return runCommand(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=8",
      peer.host,
      remoteCommand,
    ],
    { allowFailure },
  );
}

export async function runOnPeerAsync(
  peer: PeerConfig,
  command: string,
  args: readonly string[],
  allowFailure = false,
): Promise<CommandResult> {
  if (peer.host === "local") {
    return await runCommandAsync(command, args, { allowFailure });
  }
  const remoteCommand = [command, ...args].map(shellQuote).join(" ");
  return await runCommandAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=8",
      peer.host,
      remoteCommand,
    ],
    { allowFailure },
  );
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
