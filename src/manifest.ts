import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ManifestEntry } from "./types.js";

const ignoredBasenames = new Set([".DS_Store"]);

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function buildManifest(root: string): readonly ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  walk(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function walk(root: string, current: string, entries: ManifestEntry[]): void {
  for (const name of readdirSync(current).sort()) {
    if (ignoredBasenames.has(name)) continue;
    const absolute = join(current, name);
    const path = relative(root, absolute).split(sep).join("/");
    if (path.split("/").includes(".git")) continue;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      walk(root, absolute, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    const content = readFileSync(absolute);
    entries.push({
      path,
      digest: sha256(content),
      bytes: content.byteLength,
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}

export function digestManifest(entries: readonly ManifestEntry[]): string {
  return sha256(`${JSON.stringify(entries)}\n`);
}

export function findToken(root: string, token: string): readonly string[] {
  const matches: string[] = [];
  findTokenWithin(root, root, Buffer.from(token), matches);
  return matches.sort();
}

function findTokenWithin(
  root: string,
  current: string,
  token: Buffer,
  matches: string[],
): void {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      if (name !== ".git") findTokenWithin(root, absolute, token, matches);
      continue;
    }
    if (stat.isFile() && readFileSync(absolute).includes(token))
      matches.push(path);
  }
}
