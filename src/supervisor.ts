import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface SupervisionResult {
  readonly status: number;
  readonly terminatedForExpiredHeartbeat: boolean;
}

export async function superviseProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly heartbeatPath: string;
  readonly pollIntervalMs: number;
  readonly terminationGraceMs: number;
}): Promise<SupervisionResult> {
  const child = spawn(input.command, input.args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  let terminatedForExpiredHeartbeat = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const monitor = setInterval(() => {
    if (heartbeatExpired(input.heartbeatPath)) {
      terminatedForExpiredHeartbeat = true;
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(
        () => child.kill("SIGKILL"),
        input.terminationGraceMs,
      );
    }
  }, input.pollIntervalMs);
  const status = await new Promise<number>((resolveStatus, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== null) resolveStatus(code);
      else
        resolveStatus(signal === "SIGTERM" || signal === "SIGKILL" ? 143 : 1);
    });
  });
  clearInterval(monitor);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
  return { status, terminatedForExpiredHeartbeat };
}

function heartbeatExpired(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof value !== "object" ||
      value === null ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      Date.now() >= value.expiresAt
    );
  } catch {
    return true;
  }
}
