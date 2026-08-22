import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { hashText } from "../v2/hash.js";

const reserved = new Set([".codefoldersync", ".workspace-sync"]);

export function normalizeRelativePath(value: string): string {
  const unix = value.replaceAll("\\", "/");
  const parts = unix.split("/");
  if (
    unix.length === 0 ||
    unix.startsWith("/") ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.includes("\0"),
    )
  )
    throw new Error(`Unsafe relative path: ${value}`);
  for (const part of parts)
    if (Buffer.byteLength(part, "utf8") > 255)
      throw new Error(`Path component is too long: ${part}`);
  return parts.join("/");
}

export function portableName(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function isReservedPath(path: string): boolean {
  const first = path.replaceAll("\\", "/").split("/")[0];
  return first !== undefined && reserved.has(first.toLocaleLowerCase("en-US"));
}

export function safeTarget(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  const absoluteRoot = resolve(root);
  if (!target.startsWith(`${absoluteRoot}${sep}`))
    throw new Error(`Path escapes configured root: ${relativePath}`);
  return target;
}

export function relativeFrom(root: string, target: string): string {
  return normalizeRelativePath(
    relative(resolve(root), resolve(target)).replaceAll(sep, "/"),
  );
}

export function verifyRoot(root: string): void {
  if (realpathSync(root) !== resolve(root))
    throw new Error(`Configured root is a symlink: ${root}`);
}

export function assertRealAncestors(root: string, target: string): void {
  const absoluteRoot = resolve(root);
  let cursor = dirname(resolve(target));
  const values: string[] = [];
  while (cursor !== absoluteRoot) {
    if (!cursor.startsWith(`${absoluteRoot}${sep}`))
      throw new Error(`Apply path escapes configured root: ${target}`);
    values.push(cursor);
    cursor = dirname(cursor);
  }
  for (const value of values.reverse()) {
    const stat = lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe apply ancestor: ${value}`);
  }
}

export function conflictPath(
  original: string,
  peerName: string,
  eventId: string,
): string {
  const name = basename(original);
  const parent = dirname(original).replaceAll(sep, "/");
  const peer =
    peerName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase()
      .slice(0, 32) || "peer";
  const marker = `.CODEFOLDERSYNC-CONFLICT.${peer}.${eventId.slice(0, 8)}`;
  const dot = name.lastIndexOf(".");
  let candidate =
    dot <= 0
      ? `${name}${marker}`
      : `${name.slice(0, dot)}${marker}${name.slice(dot)}`;
  if (Buffer.byteLength(candidate, "utf8") > 255)
    candidate = `${name.slice(0, 80)}${marker}.${hashText(name).slice(0, 12)}`;
  return parent === "." ? candidate : `${parent}/${candidate}`;
}
