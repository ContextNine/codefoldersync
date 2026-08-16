import { createHash } from "node:crypto";

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashText(value: string): string {
  return hashBytes(Buffer.from(value, "utf8"));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hashJson(value: unknown): string {
  return hashText(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

export function assertHash(value: string, label = "Hash"): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
}
