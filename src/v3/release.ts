import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseIdentity {
  readonly version: string;
  readonly archiveSha256: string;
}

export function installedReleaseIdentity(): ReleaseIdentity | null {
  const path = resolve(
    join(dirname(fileURLToPath(import.meta.url)), "..", "release.json"),
  );
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Installed release identity is invalid");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.version !== "string" ||
    typeof record.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.archiveSha256)
  )
    throw new Error("Installed release identity is invalid");
  return {
    version: record.version,
    archiveSha256: record.archiveSha256,
  };
}
