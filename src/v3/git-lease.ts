import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertRealAncestors, normalizeRelativePath } from "./paths.js";
import {
  assertMatchingRepositoryContext,
  inspectRepositoryContext,
  ownedGitLocks,
  repositoryMetadata,
} from "./policy.js";
import type { ProductConfig, RepositoryContext } from "./types.js";

interface LeaseOwner {
  readonly pid: number;
  readonly nonce: string;
}

interface LeaseIntent extends LeaseOwner {
  readonly path: string;
}

function leaseOwner(text: string): LeaseOwner {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.nonce)
  )
    throw new Error("Invalid private Git lease owner");
  return { pid: Number(value.pid), nonce: value.nonce };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw new Error("Cannot establish whether the Git lease owner is alive");
  }
}

/** Clear only this folder's exact, nonce-qualified locks after its process died. */
export function recoverGitLease(config: ProductConfig): void {
  const journal = join(config.stateDir, "git-apply-lease.jsonl");
  if (!existsSync(journal)) return;
  if (!lstatSync(journal).isFile() || lstatSync(journal).isSymbolicLink())
    throw new Error("Private Git lease journal is unsafe");
  const lines = readFileSync(journal, "utf8").trimEnd().split("\n");
  const owner = leaseOwner(lines[0] ?? "");
  if (alive(owner.pid))
    throw new Error("Another Git-context apply is still running");
  const paths = new Set<string>();
  for (const line of lines.slice(1)) {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("path" in value) ||
      typeof value.path !== "string"
    )
      throw new Error("Invalid Git lease intent");
    const intent = leaseOwner(line);
    if (intent.pid !== owner.pid || intent.nonce !== owner.nonce)
      throw new Error("Git lease intent does not match its owner");
    // Only locks below the physical sync root can belong to this journal.
    if (
      !value.path.startsWith(`${config.root}/`) ||
      !value.path.endsWith(".lock")
    )
      throw new Error("Git lease intent escapes the registered root");
    normalizeRelativePath(relative(config.root, value.path));
    assertRealAncestors(config.root, value.path);
    paths.add(value.path);
  }
  for (const path of paths) releaseLock(path, owner);
  unlinkSync(journal);
}

function releaseLock(path: string, owner: LeaseOwner): void {
  if (!existsSync(path)) {
    ownedGitLocks.delete(path);
    return;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("Owned Git lock was replaced by an unsafe object");
  // Read only a lock whose private journal identifies our own nonce, never keys.
  const actual = leaseOwner(readFileSync(path, "utf8"));
  if (actual.pid !== owner.pid || actual.nonce !== owner.nonce)
    throw new Error("Owned Git lock was replaced; refusing to remove it");
  unlinkSync(path);
  ownedGitLocks.delete(path);
}

/** Git checkout/commit/ref writers cannot change context during the apply. */
export function acquireGitLease(
  config: ProductConfig,
  contexts: readonly RepositoryContext[],
): Disposable {
  if (config.syncPolicy.mode !== "default-branch" || contexts.length === 0)
    return { [Symbol.dispose]() {} };
  const journal = join(config.stateDir, "git-apply-lease.jsonl");
  const owner: LeaseOwner = { pid: process.pid, nonce: randomUUID() };
  const locks: string[] = [];
  const descriptor = openSync(journal, "wx", 0o600);
  let released = false;
  const dispose = (): void => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    for (const path of [...locks].reverse()) releaseLock(path, owner);
    unlinkSync(journal);
  };
  try {
    writeSync(descriptor, `${JSON.stringify(owner)}\n`);
    fsyncSync(descriptor);
    for (const context of [...contexts].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      assertMatchingRepositoryContext(
        config.syncPolicy,
        inspectRepositoryContext(config.root, context.path),
        context,
      );
      const metadata = repositoryMetadata(
        config.root,
        context.path,
      ).metadataPaths;
      const worktreeMetadata = metadata[0];
      const commonMetadata = metadata.at(-1);
      if (
        worktreeMetadata === undefined ||
        commonMetadata === undefined ||
        context.branch === null
      )
        throw new Error("Git lease requires a committed branch context");
      for (const path of [
        join(worktreeMetadata, "index.lock"),
        join(worktreeMetadata, "HEAD.lock"),
        join(commonMetadata, "refs", "heads", `${context.branch}.lock`),
      ]) {
        let parent = config.root;
        for (const component of relative(config.root, dirname(path)).split(
          "/",
        )) {
          parent = join(parent, component);
          if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
          const stat = lstatSync(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("Git lease parent is not a physical directory");
        }
        assertRealAncestors(config.root, path);
        const intent: LeaseIntent = { ...owner, path };
        writeSync(descriptor, `${JSON.stringify(intent)}\n`);
        fsyncSync(descriptor);
        writeFileSync(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
        locks.push(path);
        ownedGitLocks.add(path);
      }
      assertMatchingRepositoryContext(
        config.syncPolicy,
        inspectRepositoryContext(config.root, context.path),
        context,
      );
    }
    return { [Symbol.dispose]: dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
