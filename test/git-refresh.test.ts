import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshGitCheckout } from "../src/v3/git-refresh.js";

test("Git refresh advances only a clean matching checkout and preserves unsafe work", async () => {
  const runId = randomUUID();
  const runRoot = realpathSync(
    mkdtempSync(join(tmpdir(), `codefoldersync-${runId}-`)),
  );
  writeFileSync(join(runRoot, "SENTINEL"), `${runId}\n`);
  const workspace = join(runRoot, "workspace");
  const source = join(runRoot, "source");
  const remote = join(runRoot, "remote.git");
  mkdirSync(workspace);
  mkdirSync(source);
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const previousSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  function git(...args: string[]): string {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  try {
    assert.equal(readFileSync(join(runRoot, "SENTINEL"), "utf8"), `${runId}\n`);
    git("init", "--initial-branch=master", source);
    writeFileSync(join(source, "value.txt"), "original\n");
    git("-C", source, "add", "value.txt");
    git("-C", source, "commit", "-m", "initial");
    git("clone", "--bare", source, remote);
    git("-C", source, "remote", "add", "origin", remote);

    const checkout = join(workspace, "project");
    git("clone", remote, checkout);
    writeFileSync(join(source, "value.txt"), "published\n");
    git("-C", source, "commit", "-am", "published");
    git("-C", source, "push", "origin", "master");
    const publishedCommit = git("-C", source, "rev-parse", "HEAD");
    const input = {
      root: workspace,
      checkout: "project",
      expectedRemote: remote,
      defaultBranch: "master",
      publishedCommit,
    } as const;

    writeFileSync(join(checkout, "untracked.txt"), "keep me\n");
    assert.deepEqual(await refreshGitCheckout(input), {
      status: "skipped",
      reason: "dirty-checkout",
    });
    assert.equal(
      readFileSync(join(checkout, "untracked.txt"), "utf8"),
      "keep me\n",
    );
    assert.equal(
      readFileSync(join(checkout, "value.txt"), "utf8"),
      "original\n",
    );
    rmSync(join(checkout, "untracked.txt"));

    assert.deepEqual(
      await refreshGitCheckout({
        ...input,
        expectedRemote: join(runRoot, "other.git"),
      }),
      {
        status: "skipped",
        reason: "wrong-repository",
      },
    );
    git("-C", checkout, "switch", "-c", "feature");
    assert.deepEqual(await refreshGitCheckout(input), {
      status: "skipped",
      reason: "wrong-branch",
    });
    git("-C", checkout, "switch", "master");

    assert.deepEqual(await refreshGitCheckout(input), {
      status: "refreshed",
      before: git("-C", source, "rev-parse", "HEAD^"),
      after: publishedCommit,
    });
    assert.equal(
      readFileSync(join(checkout, "value.txt"), "utf8"),
      "published\n",
    );
    assert.deepEqual(await refreshGitCheckout(input), {
      status: "skipped",
      reason: "already-current",
    });

    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.txt\n");
    writeFileSync(join(checkout, "ignored.txt"), "local ignored work\n");
    writeFileSync(join(source, "ignored.txt"), "incoming tracked work\n");
    git("-C", source, "add", "ignored.txt");
    git("-C", source, "commit", "-m", "track ignored path");
    git("-C", source, "push", "origin", "master");
    const ignoredCommit = git("-C", source, "rev-parse", "HEAD");
    assert.deepEqual(
      await refreshGitCheckout({ ...input, publishedCommit: ignoredCommit }),
      { status: "skipped", reason: "untracked-collision" },
    );
    assert.equal(
      readFileSync(join(checkout, "ignored.txt"), "utf8"),
      "local ignored work\n",
    );

    writeFileSync(join(checkout, "local.txt"), "local commit\n");
    git("-C", checkout, "add", "local.txt");
    git("-C", checkout, "commit", "-m", "local work");
    writeFileSync(join(source, "value.txt"), "new remote version\n");
    git("-C", source, "commit", "-am", "new version");
    git("-C", source, "push", "origin", "master");
    const nextCommit = git("-C", source, "rev-parse", "HEAD");
    const localHead = git("-C", checkout, "rev-parse", "HEAD");
    assert.deepEqual(
      await refreshGitCheckout({ ...input, publishedCommit: nextCommit }),
      {
        status: "skipped",
        reason: "divergent",
      },
    );
    assert.equal(git("-C", checkout, "rev-parse", "HEAD"), localHead);
    assert.equal(
      readFileSync(join(checkout, "local.txt"), "utf8"),
      "local commit\n",
    );
  } finally {
    if (previousGlobalConfig === undefined)
      delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    if (previousSystemConfig === undefined)
      delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystemConfig;
    if (readFileSync(join(runRoot, "SENTINEL"), "utf8") === `${runId}\n`)
      rmSync(runRoot, { recursive: true, force: true });
  }
});
