import { dirname } from "node:path";
import { runOnPeer } from "./executor.js";
import type { HarnessConfig, PeerName } from "./types.js";

export interface DoctorPeerResult {
  readonly peer: PeerName;
  readonly ready: boolean;
  readonly hostname: string;
  readonly os: string;
  readonly architecture: string;
  readonly gitVersion: string;
  readonly nodeVersion: string;
  readonly treesyncVersion: string;
  readonly treesyncCapabilities: readonly string[];
  readonly freeKilobytes: number;
  readonly issues: readonly string[];
}

const probeScript = `
set +e
printf 'HOST\\t'; hostname
printf 'OS\\t'; uname -s
printf 'ARCH\\t'; uname -m
printf 'GIT\\t'; git --version
printf 'NODE\\t'; "$1" --version
printf 'TREESYNC\\t'; "$2" --version
for command in status start stop push link join; do
  if "$2" "$command" --help >/dev/null 2>&1; then printf 'CAP\\t%s\\n' "$command"; fi
done
df -Pk "$3" | awk 'END { printf "FREE\\t%s\\n", $(NF-2) }'
`;

export function doctor(config: HarnessConfig): readonly DoctorPeerResult[] {
  return config.peers.map((peer) => {
    const result = runOnPeer(
      peer,
      "/bin/sh",
      [
        "-c",
        probeScript,
        "sh",
        peer.nodeBinary,
        peer.treesyncBinary,
        dirname(peer.runBase),
      ],
      true,
    );
    if (
      result.status === 255 ||
      result.stderr.includes("Connection timed out")
    ) {
      return unavailable(peer.name, "ssh-unreachable");
    }
    const fields = parseFields(result.stdout);
    const capabilities = fields.get("CAP") ?? [];
    const issues: string[] = [];
    if ((fields.get("HOST")?.[0] ?? "").length === 0)
      issues.push("hostname-unavailable");
    if ((fields.get("OS")?.[0] ?? "").length === 0)
      issues.push("uname-unavailable");
    if ((fields.get("GIT")?.[0] ?? "").length === 0)
      issues.push("git-unavailable");
    if ((fields.get("NODE")?.[0] ?? "").length === 0)
      issues.push("node-unavailable");
    if ((fields.get("TREESYNC")?.[0] ?? "").length === 0)
      issues.push("treesync-unavailable");
    if (capabilities.length !== 6) issues.push("treesync-capability-mismatch");
    const freeKilobytes = Number(fields.get("FREE")?.[0] ?? 0);
    if (!Number.isFinite(freeKilobytes) || freeKilobytes < 1_000_000)
      issues.push("insufficient-free-space");
    return {
      peer: peer.name,
      ready: issues.length === 0,
      hostname: fields.get("HOST")?.[0] ?? "",
      os: fields.get("OS")?.[0] ?? "",
      architecture: fields.get("ARCH")?.[0] ?? "",
      gitVersion: fields.get("GIT")?.[0] ?? "",
      nodeVersion: fields.get("NODE")?.[0] ?? "",
      treesyncVersion: fields.get("TREESYNC")?.[0] ?? "",
      treesyncCapabilities: capabilities,
      freeKilobytes,
      issues,
    };
  });
}

function parseFields(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    const values = result.get(key) ?? [];
    values.push(value);
    result.set(key, values);
  }
  return result;
}

function unavailable(peer: PeerName, issue: string): DoctorPeerResult {
  return {
    peer,
    ready: false,
    hostname: "",
    os: "",
    architecture: "",
    gitVersion: "",
    nodeVersion: "",
    treesyncVersion: "",
    treesyncCapabilities: [],
    freeKilobytes: 0,
    issues: [issue],
  };
}
