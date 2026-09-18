import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertRealAncestors,
  isReservedPath,
  safeTarget,
  verifyRoot,
} from "./paths.js";

const execute = promisify(execFile);
const commitPattern = /^[a-f0-9]{40}$/u;
const remoteNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

export type GitRefreshResult =
  | {
      readonly status: "refreshed";
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "unsafe-checkout"
        | "wrong-repository"
        | "wrong-branch"
        | "dirty-checkout"
        | "untracked-collision"
        | "no-upstream"
        | "already-current"
        | "divergent"
        | "publication-not-upstream"
        | "fetch-unavailable"
        | "verification-failed";
    };

function remoteIdentity(value: string): string | null {
  const scp = /^(?:git@)?([A-Za-z0-9.-]+):([^?#]+)$/u.exec(value);
  if (scp)
    return `${scp[1]?.toLowerCase()}/${scp[2]?.replace(/\.git$/u, "").toLowerCase()}`;
  try {
    const url = new URL(value);
    if (url.protocol === "file:")
      return `file:${resolve(decodeURIComponent(url.pathname))}`;
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
    if (!url.hostname || url.search || url.hash || url.password) return null;
    if (url.protocol === "https:" && url.username) return null;
    return `${url.hostname.toLowerCase()}/${url.pathname
      .replace(/^\//u, "")
      .replace(/\.git$/u, "")
      .toLowerCase()}`;
  } catch {
    return value.startsWith("/") ? `file:${resolve(value)}` : null;
  }
}

function contained(root: string, target: string): boolean {
  const inside = relative(root, target);
  return (
    inside !== ".." && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep)
  );
}

async function gitRaw(
  checkout: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execute(
    "git",
    ["-C", checkout, "-c", "core.hooksPath=/dev/null", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout;
}

async function git(checkout: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(checkout, args)).trim();
}

async function hasUntrackedCollision(
  checkout: string,
  before: string,
  after: string,
): Promise<boolean> {
  const changed = await gitRaw(checkout, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACMR",
    before,
    after,
  ]);
  for (const path of changed.split("\0").filter(Boolean)) {
    const parts = path.split("/");
    let target = checkout;
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      let details;
      try {
        details = lstatSync(target);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          break;
        throw error;
      }
      if (details.isSymbolicLink()) return true;
      if (index < parts.length - 1 && !details.isDirectory()) return true;
      if (index === parts.length - 1) {
        const tracked = await gitRaw(checkout, [
          "ls-files",
          "-z",
          "--cached",
          "--",
          `:(literal)${path}`,
        ]);
        if (!tracked.split("\0").includes(path)) return true;
      }
    }
  }
  return false;
}

async function isAncestor(
  checkout: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Called only while CodeFolderSync owns its writer lock. Never stashes or resets a checkout. */
export async function refreshGitCheckout(input: {
  readonly root: string;
  readonly checkout: string;
  readonly expectedRemote: string;
  readonly defaultBranch: string;
  readonly publishedCommit: string;
}): Promise<GitRefreshResult> {
  if (
    !commitPattern.test(input.publishedCommit) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input.defaultBranch) ||
    input.defaultBranch.includes("..")
  ) {
    return { status: "skipped", reason: "unsafe-checkout" };
  }
  const expectedIdentity = remoteIdentity(input.expectedRemote);
  if (!expectedIdentity)
    return { status: "skipped", reason: "wrong-repository" };
  let checkout: string;
  try {
    verifyRoot(input.root);
    if (isReservedPath(input.checkout)) throw new Error("reserved path");
    checkout = safeTarget(input.root, input.checkout);
    assertRealAncestors(input.root, checkout);
    const details = lstatSync(checkout);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error("unsafe checkout");
    const gitDirectory = realpathSync(
      await git(checkout, ["rev-parse", "--absolute-git-dir"]),
    );
    if (!contained(resolve(input.root), gitDirectory))
      throw new Error("external Git directory");
    const top = realpathSync(
      await git(checkout, ["rev-parse", "--show-toplevel"]),
    );
    if (top !== checkout) throw new Error("not exact checkout");
  } catch {
    return { status: "skipped", reason: "unsafe-checkout" };
  }
  const branch = await git(checkout, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]).catch(() => "");
  if (branch !== input.defaultBranch)
    return { status: "skipped", reason: "wrong-branch" };
  const initialStatus = await git(checkout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).catch(() => null);
  if (initialStatus === null)
    return { status: "skipped", reason: "unsafe-checkout" };
  if (initialStatus) {
    return { status: "skipped", reason: "dirty-checkout" };
  }
  const remoteName = await git(checkout, [
    "config",
    "--get",
    `branch.${branch}.remote`,
  ]).catch(() => "");
  const mergeRef = await git(checkout, [
    "config",
    "--get",
    `branch.${branch}.merge`,
  ]).catch(() => "");
  if (
    !remoteNamePattern.test(remoteName) ||
    mergeRef !== `refs/heads/${branch}`
  ) {
    return { status: "skipped", reason: "no-upstream" };
  }
  const configuredRemote = await git(checkout, [
    "remote",
    "get-url",
    remoteName,
  ]).catch(() => "");
  if (remoteIdentity(configuredRemote) !== expectedIdentity) {
    return { status: "skipped", reason: "wrong-repository" };
  }
  const before = await git(checkout, ["rev-parse", "HEAD"]).catch(() => "");
  if (!commitPattern.test(before))
    return { status: "skipped", reason: "unsafe-checkout" };
  try {
    await git(checkout, ["fetch", "--no-tags", remoteName, branch]);
  } catch {
    return { status: "skipped", reason: "fetch-unavailable" };
  }
  const after = await git(checkout, ["rev-parse", "FETCH_HEAD"]).catch(
    () => "",
  );
  if (!commitPattern.test(after))
    return { status: "skipped", reason: "fetch-unavailable" };
  if (!(await isAncestor(checkout, input.publishedCommit, after))) {
    return { status: "skipped", reason: "publication-not-upstream" };
  }
  if (before === after) return { status: "skipped", reason: "already-current" };
  if (!(await isAncestor(checkout, before, after)))
    return { status: "skipped", reason: "divergent" };
  const stillHead = await git(checkout, ["rev-parse", "HEAD"]).catch(() => "");
  const stillBranch = await git(checkout, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]).catch(() => "");
  const stillStatus = await git(checkout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).catch(() => null);
  if (stillHead !== before || stillBranch !== branch || stillStatus !== "") {
    return { status: "skipped", reason: "dirty-checkout" };
  }
  try {
    if (await hasUntrackedCollision(checkout, before, after))
      return { status: "skipped", reason: "untracked-collision" };
  } catch {
    return { status: "skipped", reason: "unsafe-checkout" };
  }
  try {
    await git(checkout, ["merge", "--ff-only", "FETCH_HEAD"]);
  } catch {
    return { status: "skipped", reason: "divergent" };
  }
  if ((await git(checkout, ["rev-parse", "HEAD"]).catch(() => "")) !== after) {
    return { status: "skipped", reason: "verification-failed" };
  }
  return { status: "refreshed", before, after };
}
