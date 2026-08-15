import { createHash } from "node:crypto";
import type { GitSnapshot, RepositoryName } from "./types.js";
import { runCommand } from "./process.js";

const fixtureIdentity = [
  "-c",
  "user.name=TreeSync Harness",
  "-c",
  "user.email=treesync-harness@invalid.example",
] as const;

export function git(
  repositoryPath: string,
  args: readonly string[],
  allowFailure = false,
) {
  return runCommand("git", [...fixtureIdentity, ...args], {
    cwd: repositoryPath,
    allowFailure,
  });
}

export function snapshotGit(
  repository: RepositoryName,
  repositoryPath: string,
): GitSnapshot {
  const fsck = git(repositoryPath, ["fsck", "--full"], true);
  const symbolicHead = git(
    repositoryPath,
    ["symbolic-ref", "-q", "HEAD"],
    true,
  );
  const headOid = git(repositoryPath, ["rev-parse", "--verify", "HEAD"], true);
  const indexTree = git(repositoryPath, ["write-tree"], true);
  const refsOutput = git(repositoryPath, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  const refs: Record<string, string> = {};
  for (const line of refsOutput.stdout.trim().split("\n")) {
    if (line.length === 0) continue;
    const [name, oid] = line.split("\0");
    if (name !== undefined && oid !== undefined) refs[name] = oid;
  }
  const status = git(repositoryPath, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "-z",
  ]);
  return {
    repository,
    valid: fsck.status === 0 && headOid.status === 0 && indexTree.status === 0,
    fsckOutput: `${fsck.stdout}${fsck.stderr}`.trim(),
    head: symbolicHead.stdout.trim() || "DETACHED",
    headOid: headOid.stdout.trim(),
    indexTree: indexTree.stdout.trim(),
    refs,
    statusDigest: createHash("sha256").update(status.stdout).digest("hex"),
  };
}

export function requiredCommitExists(
  repositoryPath: string,
  commitOid: string,
): boolean {
  return (
    git(repositoryPath, ["cat-file", "-e", `${commitOid}^{commit}`], true)
      .status === 0
  );
}

export function refEquals(
  repositoryPath: string,
  refName: string,
  commitOid: string,
): boolean {
  const result = git(repositoryPath, ["rev-parse", "--verify", refName], true);
  return result.status === 0 && result.stdout.trim() === commitOid;
}
