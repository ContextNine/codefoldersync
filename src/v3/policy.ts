import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { hashJson } from "../v2/hash.js";
import { normalizeRelativePath } from "./paths.js";
import type { RepositoryContext, SyncPolicy } from "./types.js";

// Owned apply locks are excluded only in this process; other writers still fail.
export const ownedGitLocks = new Set<string>();

export const defaultSyncPolicy: SyncPolicy = {
  mode: "selected-files",
  includes: ["**"],
  plaintextEnv: false,
};

export const plaintextEnvPolicy: SyncPolicy = {
  mode: "selected-files",
  includes: ["**/.env", "**/.env.*"],
  plaintextEnv: true,
};

const compiledPatterns = new WeakMap<SyncPolicy, readonly RegExp[]>();

function includeExpressions(policy: SyncPolicy): readonly RegExp[] {
  if (policy.mode === "default-branch") return [];
  let expressions = compiledPatterns.get(policy);
  if (expressions === undefined) {
    expressions = policy.includes.map(compileInclude);
    compiledPatterns.set(policy, expressions);
  }
  return expressions;
}

export function policyIncludesDirectory(
  policy: SyncPolicy,
  path: string,
): boolean {
  return (
    policyIncludes(policy, path) ||
    (policy.mode === "selected-files" &&
      !isPlaintextEnvPath(path) &&
      includeExpressions(policy).some((expression) =>
        expression.test(`${path}/`),
      ))
  );
}

export function validateSyncPolicy(
  value: unknown,
): asserts value is SyncPolicy {
  if (typeof value !== "object" || value === null)
    throw new Error("An explicit synchronization policy is required");
  if (!("mode" in value)) throw new Error("Synchronization policy has no mode");
  if (value.mode === "default-branch") {
    if (
      !("branch" in value) ||
      typeof value.branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value.branch) ||
      value.branch.includes("..") ||
      value.branch.endsWith("/")
    )
      throw new Error("Default-branch policy requires a valid branch name");
  } else if (value.mode === "selected-files") {
    if (
      !("includes" in value) ||
      !Array.isArray(value.includes) ||
      value.includes.length === 0 ||
      !("plaintextEnv" in value) ||
      typeof value.plaintextEnv !== "boolean"
    )
      throw new Error(
        "Selected-files policy requires patterns and ENV consent",
      );
    for (const pattern of value.includes) {
      if (typeof pattern !== "string")
        throw new Error("Include patterns must be strings");
      compileInclude(pattern);
    }
  } else throw new Error("Unknown synchronization policy mode");
}

/** Patterns are root-relative; globstar prefixes also match the root itself. */
export function compileInclude(pattern: string): RegExp {
  if (
    pattern.length === 0 ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    pattern.split("/").some((part) => part === ".." || part === ".")
  )
    throw new Error("Include patterns must be safe relative paths");
  const text = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let expression = "^";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "*" && text[index + 1] === "*") {
      if (text[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else
      expression += (character ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

export function isPlaintextEnvPath(path: string): boolean {
  const name = basename(path);
  return (
    (name === ".env" || name.startsWith(".env.")) &&
    !/^\.env\.(?:base|example|sample|template)(?:\.|$)/u.test(name) &&
    !/\.(?:example|sample|template)$/u.test(name) &&
    !name.endsWith(".sops") &&
    !name.endsWith(".age") &&
    !name.endsWith(".gpg")
  );
}

/** Always check custody before capturing bytes, including broad allowlists. */
export function policyIncludes(policy: SyncPolicy, path: string): boolean {
  normalizeRelativePath(path);
  const parts = path.split("/");
  if (
    parts.some((part) =>
      [".git", ".codefoldersync", ".workspace-sync"].includes(
        part.toLowerCase(),
      ),
    ) ||
    basename(path) === ".codefoldersyncignore"
  )
    return false;
  if (isPlaintextEnvPath(path))
    return (
      policy.mode === "selected-files" &&
      policy.plaintextEnv &&
      includeExpressions(policy).some((expression) => expression.test(path))
    );
  if (
    policy.mode === "selected-files" &&
    policy.plaintextEnv &&
    policy.includes.every((pattern) =>
      ["**/.env", "**/.env.*"].includes(pattern),
    )
  )
    return false;
  return (
    policy.mode === "default-branch" ||
    includeExpressions(policy).some((expression) => expression.test(path))
  );
}

function git(root: string, args: readonly string[]): string | null {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-C", root, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Read Git context, never Git file contents or credential-bearing output. */
export function inspectRepositoryContext(
  root: string,
  path: string,
  onMetadata?: (paths: readonly string[]) => void,
): RepositoryContext {
  const { worktree, metadataPaths } = repositoryMetadata(root, path);
  onMetadata?.(metadataPaths);
  for (const directory of metadataPaths) {
    if (
      readdirSync(directory).some(
        (name) =>
          name.endsWith(".lock") &&
          name !== "codex-repo-sync.lock" &&
          !ownedGitLocks.has(join(directory, name)),
      ) ||
      [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
      ].some((name) => existsSync(join(directory, name)))
    )
      throw new Error(
        "Git mutation is in progress; repository synchronization is paused",
      );
  }
  for (const directory of metadataPaths) {
    const refs = join(directory, "refs");
    const inspectRefs = (target: string): void => {
      if (!existsSync(target)) return;
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        const path = join(target, entry.name);
        if (entry.name.endsWith(".lock") && !ownedGitLocks.has(path))
          throw new Error(
            "Git reference mutation is in progress; synchronization is paused",
          );
        if (entry.isDirectory() && !entry.isSymbolicLink()) inspectRefs(path);
      }
    };
    inspectRefs(refs);
  }
  const head = git(worktree, ["rev-parse", "--verify", "HEAD"]);
  const branch = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  // Root commits are stable across clones; remotes may embed credentials.
  const roots = git(worktree, ["rev-list", "--max-parents=0", "HEAD"]);
  if (roots === null || roots.length === 0)
    throw new Error(
      "Unborn repositories must be committed before synchronization",
    );
  return {
    path: relative(root, worktree).replaceAll(sep, "/"),
    identity: hashJson(roots.split("\n").sort()),
    branch,
    head,
  };
}

/** Selected files need metadata exclusion, not an eligible Git checkout. */
export function repositoryMetadata(
  root: string,
  path: string,
): {
  readonly worktree: string;
  readonly metadataPaths: readonly string[];
} {
  const worktree = join(root, path);
  const entry = join(worktree, ".git");
  const entryStat = lstatSync(entry);
  if (entryStat.isSymbolicLink())
    throw new Error("Symlinked Git entry is unsafe");
  let metadata = entry;
  if (entryStat.isFile()) {
    const match = /^gitdir:\s*(.+)$/u.exec(readFileSync(entry, "utf8").trim());
    if (match?.[1] === undefined) throw new Error("Malformed Git indirection");
    metadata = resolve(worktree, match[1]);
  }
  const physicalRoot = resolve(root);
  if (
    metadata !== physicalRoot &&
    !metadata.startsWith(`${physicalRoot}${sep}`)
  )
    throw new Error("External Git directory is unsupported");
  if (
    !lstatSync(metadata).isDirectory() ||
    lstatSync(metadata).isSymbolicLink() ||
    realpathSync(metadata) !== metadata
  )
    throw new Error("Git metadata must be a physical directory");
  const common = git(worktree, ["rev-parse", "--git-common-dir"]);
  if (common === null) throw new Error("Invalid repository context");
  const commonPath = resolve(worktree, common);
  if (
    commonPath !== physicalRoot &&
    !commonPath.startsWith(`${physicalRoot}${sep}`)
  )
    throw new Error("External Git common directory is unsupported");
  if (
    !lstatSync(commonPath).isDirectory() ||
    realpathSync(commonPath) !== commonPath
  )
    throw new Error("Git common metadata must be a physical directory");
  return { worktree, metadataPaths: [...new Set([metadata, commonPath])] };
}

export function assertMatchingRepositoryContext(
  policy: SyncPolicy,
  local: RepositoryContext,
  accepted: RepositoryContext,
): void {
  if (local.path !== accepted.path || local.identity !== accepted.identity)
    throw new Error("Repository identity does not match the accepted scope");
  if (
    policy.mode === "default-branch" &&
    (local.branch !== policy.branch ||
      accepted.branch !== policy.branch ||
      local.head === null ||
      local.head !== accepted.head)
  )
    throw new Error(
      "Repository branch or HEAD differs; synchronization is paused",
    );
}
