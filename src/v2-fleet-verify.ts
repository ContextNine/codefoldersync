#!/usr/bin/env node

import {
  closeSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  readSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

const input = process.argv[2];
if (input === undefined) throw new Error("Usage: v2-fleet-verify <workspace>");
const root = resolve(input);

const aggregate = createHash("sha256");
let files = 0;
let directories = 0;
let symlinks = 0;
let conflicts = 0;

function add(...parts: readonly string[]): void {
  for (const part of parts) {
    aggregate.update(String(Buffer.byteLength(part, "utf8")));
    aggregate.update(":");
    aggregate.update(part);
    aggregate.update("\0");
  }
}

function fileDigest(path: string): string {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
}

function walk(directory: string, relative: string): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name, "en"),
  );
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    const child =
      relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const stat = lstatSync(path);
    if (entry.name.includes("CODEFOLDERSYNC-CONFLICT")) conflicts += 1;
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      add("symlink", child, readlinkSync(path, "utf8"));
      continue;
    }
    if (stat.isDirectory()) {
      directories += 1;
      add("directory", child);
      walk(path, child);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Unsupported object: ${path}`);
    files += 1;
    add(
      "regular",
      child,
      String(stat.size),
      String((stat.mode & 0o111) !== 0),
      fileDigest(path),
    );
  }
}

walk(root, "");

const repositories = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const repository = join(root, entry.name);
    const fsck = git(repository, ["fsck", "--full"]);
    const value = {
      name: entry.name,
      head: git(repository, ["rev-parse", "HEAD"]),
      headTree: git(repository, ["rev-parse", "HEAD^{tree}"]),
      refs: git(repository, [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname) %(objectname)",
      ]),
      index: git(repository, ["ls-files", "-s"]),
      fsck: fsck.length === 0 ? "clean" : fsck,
    };
    return {
      name: value.name,
      head: value.head,
      headTree: value.headTree,
      refsDigest: digest(value.refs),
      indexDigest: digest(value.index),
      trackedFiles:
        value.index.length === 0 ? 0 : value.index.split("\n").length,
      fsck: value.fsck,
      digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    };
  });

process.stdout.write(
  `${JSON.stringify(
    {
      workspace: basename(root),
      digest: aggregate.digest("hex"),
      files,
      directories,
      symlinks,
      conflicts,
      repositories,
    },
    null,
    2,
  )}\n`,
);

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-C", repository, ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      `Git verification failed for ${repository}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
