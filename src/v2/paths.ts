import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { hashText } from "./hash.js";

const reservedSegment = /^\.codefoldersync(?:-|$)/iu;

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
  ) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  for (const part of parts) {
    if (Buffer.byteLength(part, "utf8") > 255)
      throw new Error(`Path component is too long: ${part}`);
    if (reservedSegment.test(part))
      throw new Error(`Path uses a reserved CodeFolderSync name: ${part}`);
  }
  return parts.join("/");
}

export function normalizedEntryKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function assertInside(root: string, target: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (
    absoluteTarget !== absoluteRoot &&
    !absoluteTarget.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error(`Path escapes configured root: ${target}`);
  }
  return absoluteTarget;
}

export function safeTarget(root: string, relativePath: string): string {
  return assertInside(
    root,
    join(root, ...normalizeRelativePath(relativePath).split("/")),
  );
}

export function assertRealDirectoryAncestors(
  root: string,
  target: string,
): void {
  const absoluteRoot = resolve(root);
  let cursor = dirname(resolve(target));
  const ancestors: string[] = [];
  while (cursor !== absoluteRoot) {
    assertInside(absoluteRoot, cursor);
    ancestors.push(cursor);
    cursor = dirname(cursor);
  }
  for (const ancestor of ancestors.reverse()) {
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe apply ancestor: ${ancestor}`);
    }
  }
}

export function relativeFrom(root: string, target: string): string {
  const value = relative(resolve(root), resolve(target)).replaceAll(sep, "/");
  return normalizeRelativePath(value);
}

export function conflictName(
  originalName: string,
  peerName: string,
  eventId: string,
  prefixLength = 8,
): string {
  const peer = slug(peerName).slice(0, 32) || "peer";
  const marker = `.CODEFOLDERSYNC-CONFLICT.${peer}.${eventId.slice(0, prefixLength)}`;
  const dot = extensionBoundary(originalName);
  const candidate =
    dot <= 0
      ? `${originalName}${marker}`
      : `${originalName.slice(0, dot)}${marker}${originalName.slice(dot)}`;
  if (Buffer.byteLength(candidate, "utf8") <= 255) return candidate;
  const digest = hashText(originalName).slice(0, 12);
  const extension = dot <= 0 ? "" : originalName.slice(dot).slice(0, 32);
  const available = 255 - Buffer.byteLength(`${marker}.${digest}${extension}`);
  return `${truncateUtf8(originalName.slice(0, Math.max(dot, 0)), available)}${marker}.${digest}${extension}`;
}

export function pathContainsGit(relativePath: string): boolean {
  return relativePath.split("/").includes(".git");
}

export function repositoryName(root: string, target: string): string {
  const value = relative(resolve(root), resolve(target)).split(sep)[0];
  if (value === undefined || value.length === 0 || value === "..") {
    throw new Error(`Path is outside a repository: ${target}`);
  }
  return value;
}

export function verifyNoSymlinkEscape(root: string): void {
  const real = realpathSync(root);
  if (real !== resolve(root))
    throw new Error(`Configured root is a symlink: ${root}`);
}

function extensionBoundary(name: string): number {
  const index = name.lastIndexOf(".");
  return index <= 0 ? -1 : index;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function truncateUtf8(value: string, bytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > bytes) break;
    result += character;
  }
  return result || basename(value).slice(0, 1) || "file";
}
