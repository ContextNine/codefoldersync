import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activatePeerV3,
  enrollPeerV3,
  preparePeerEnrollment,
  setupAuthorityV3,
} from "../src/v3/setup.js";
import {
  applyAdoptionV3,
  cutoverAdoptionV3,
  statusV3,
  recoverHeldFileV3,
  planAdoptionV3,
  sealSourceV3,
  syncFolderV3,
  verifyFullV3,
} from "../src/v3/engine.js";
import { plaintextEnvPolicy } from "../src/v3/policy.js";
import { LocalState } from "../src/v3/state.js";
import type { ProductConfig, SyncPolicy } from "../src/v3/types.js";

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "user.name=Sync Acceptance",
      "-c",
      "user.email=sync@invalid.example",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function synced(result: Awaited<ReturnType<typeof syncFolderV3>>): void {
  assert.ok(
    ["clean", "conflict"].includes(result.status),
    JSON.stringify(result),
  );
}

function crashApplying(config: ProductConfig): void {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { loadConfig } from './src/v3/config.ts';
    import { syncFolderV3 } from './src/v3/engine.ts';
    await syncFolderV3(loadConfig(process.argv[1]), { fault(point) {
      if (point === 'after-apply-journal') process.kill(process.pid, 'SIGKILL');
    }});
  `,
      join(config.root, ".codefoldersync", "config.json"),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

async function withPolicyFleet(
  syncPolicy: SyncPolicy,
  action: (source: ProductConfig, target: ProductConfig) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-policy-"));
  const sentinel = "policy-integration";
  writeFileSync(join(base, "SENTINEL"), sentinel);
  try {
    const sourceRoot = join(base, "source", "workspace");
    const targetRoot = join(base, "target", "workspace");
    mkdirSync(sourceRoot, { recursive: true });
    git(sourceRoot, "init", "-b", "master");
    writeFileSync(join(sourceRoot, "source.ts"), "export const value = 1;\n");
    writeFileSync(join(sourceRoot, ".gitignore"), ".env*\n");
    git(sourceRoot, "add", ".");
    git(sourceRoot, "commit", "-m", "fixture");
    if (syncPolicy.mode === "default-branch") {
      writeFileSync(join(sourceRoot, ".gitignore"), ".env*\npackages/\n");
      git(sourceRoot, "add", ".gitignore");
      git(sourceRoot, "commit", "-m", "independent nested repositories");
      for (const path of [
        "packages/paused",
        "packages/paused/inner",
        "packages/healthy",
      ]) {
        const root = join(sourceRoot, path);
        mkdirSync(root, { recursive: true });
        git(root, "init", "-b", "master");
        writeFileSync(
          join(root, "source.ts"),
          `export const name = ${JSON.stringify(path)};\n`,
        );
        writeFileSync(join(root, ".gitignore"), "inner/\n");
        git(root, "add", ".");
        git(root, "commit", "-m", `fixture ${path}`);
      }
    }
    writeFileSync(join(sourceRoot, ".env"), "SYNTHETIC_FIXTURE=initial\n");
    cpSync(sourceRoot, targetRoot, { recursive: true });
    let source = (
      await setupAuthorityV3({
        root: sourceRoot,
        stateDir: join(base, "source", "state"),
        folderName: "policy-fixture",
        peerName: "source",
        hub: { kind: "local", path: join(base, "hub") },
        backupWitness: "synthetic-fixture",
        syncPolicy,
      })
    ).config;
    const request = preparePeerEnrollment({
      acceptedConfig: source,
      root: targetRoot,
      stateDir: join(base, "target", "state"),
      peerName: "target",
      requestPath: join(base, "request.json"),
    });
    source = await enrollPeerV3({
      authorityConfig: source,
      authorityConfigPath: join(sourceRoot, ".codefoldersync", "config.json"),
      request,
    });
    let target = activatePeerV3({
      acceptedConfig: source,
      request,
      stateDir: join(base, "target", "state"),
      configPath: join(targetRoot, ".codefoldersync", "config.json"),
    });
    await sealSourceV3(source);
    const plan = await planAdoptionV3(target);
    await applyAdoptionV3(target, plan.adoptionId);
    source = await cutoverAdoptionV3(
      source,
      join(sourceRoot, ".codefoldersync", "config.json"),
    );
    target = activatePeerV3({
      acceptedConfig: source,
      request,
      stateDir: target.stateDir,
      configPath: join(targetRoot, ".codefoldersync", "config.json"),
    });
    await action(source, target);
  } finally {
    assert.equal(readFileSync(join(base, "SENTINEL"), "utf8"), sentinel);
    rmSync(base, { recursive: true });
  }
}

test("ENV-only peers share requested values across independent checkouts and retain local data", async () => {
  await withPolicyFleet(plaintextEnvPolicy, async (source, target) => {
    git(target.root, "switch", "-c", "feature");
    writeFileSync(join(target.root, "source.ts"), "export const value = 99;\n");
    git(target.root, "add", "source.ts");
    const branch = git(target.root, "symbolic-ref", "--short", "HEAD");
    const head = git(target.root, "rev-parse", "HEAD");
    const index = readFileSync(join(target.root, ".git", "index"));
    const localCode = readFileSync(join(target.root, "source.ts"), "utf8");
    writeFileSync(join(source.root, ".env"), "SYNTHETIC_FIXTURE=updated\n");
    writeFileSync(
      join(source.root, ".env.base"),
      "PUBLIC_CONTRACT=source-only\n",
    );
    writeFileSync(
      join(target.root, ".env.base"),
      "PUBLIC_CONTRACT=target-only\n",
    );
    synced(await syncFolderV3(source));
    synced(await syncFolderV3(target));
    assert.equal(
      readFileSync(join(target.root, ".env"), "utf8"),
      "SYNTHETIC_FIXTURE=updated\n",
    );
    assert.equal(lstatSync(join(target.root, ".env")).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(join(target.root, ".env.base"), "utf8"),
      "PUBLIC_CONTRACT=target-only\n",
    );
    assert.equal(
      readFileSync(join(target.root, "source.ts"), "utf8"),
      localCode,
    );
    assert.equal(git(target.root, "symbolic-ref", "--short", "HEAD"), branch);
    assert.equal(git(target.root, "rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(target.root, ".git", "index")), index);

    // ENV transfer is independent of a sibling repository's unborn/locked state.
    const scratch = join(target.root, "scratch");
    mkdirSync(scratch);
    git(scratch, "init", "-b", "different-branch");
    writeFileSync(join(scratch, ".git", "index.lock"), "synthetic-lock\n");
    writeFileSync(
      join(source.root, ".env"),
      "SYNTHETIC_FIXTURE=with-unborn-sibling\n",
    );
    synced(await syncFolderV3(source));
    synced(await syncFolderV3(target));
    assert.equal(
      readFileSync(join(target.root, ".env"), "utf8"),
      "SYNTHETIC_FIXTURE=with-unborn-sibling\n",
    );
    assert.equal(
      readFileSync(join(scratch, ".git", "index.lock"), "utf8"),
      "synthetic-lock\n",
    );
    rmSync(join(scratch, ".git", "index.lock"));

    symlinkSync("source.ts", join(source.root, ".env.link"));
    const codeMode = lstatSync(join(target.root, "source.ts")).mode;
    synced(await syncFolderV3(source));
    synced(await syncFolderV3(target));
    assert.equal(
      readFileSync(join(target.root, ".env.link"), "utf8"),
      localCode,
    );
    assert.equal(lstatSync(join(target.root, "source.ts")).mode, codeMode);

    mkdirSync(join(source.root, "apps", "worker"), { recursive: true });
    mkdirSync(join(target.root, "apps", "worker"), { recursive: true });
    writeFileSync(
      join(target.root, "apps", "worker", "local.ts"),
      "local-only\n",
    );
    writeFileSync(
      join(source.root, "apps", "worker", ".env.local"),
      "SYNTHETIC_WORKER=one\n",
    );
    synced(await syncFolderV3(source));
    synced(await syncFolderV3(target));
    assert.equal(
      readFileSync(join(target.root, "apps", "worker", ".env.local"), "utf8"),
      "SYNTHETIC_WORKER=one\n",
    );
    rmSync(join(source.root, "apps", "worker", ".env.local"));
    synced(await syncFolderV3(source));
    synced(await syncFolderV3(target));
    assert.equal(
      readFileSync(join(target.root, "apps", "worker", "local.ts"), "utf8"),
      "local-only\n",
    );

    writeFileSync(
      join(source.root, ".env"),
      "SYNTHETIC_FIXTURE=source-conflict\n",
    );
    writeFileSync(
      join(target.root, ".env"),
      "SYNTHETIC_FIXTURE=target-conflict\n",
    );
    synced(await syncFolderV3(source));
    const conflict = await syncFolderV3(target);
    synced(conflict);
    assert.equal(conflict.status, "conflict");
    const retained = readdirSync(target.root).filter((name) =>
      name.includes("CODEFOLDERSYNC-CONFLICT"),
    );
    assert.ok(
      retained.some(
        (name) =>
          readFileSync(join(target.root, name), "utf8") ===
          "SYNTHETIC_FIXTURE=target-conflict\n",
      ),
    );
    synced(await syncFolderV3(source));
    assert.equal((await verifyFullV3(target)).status, "conflict");
  });
});

test("default-branch peers transfer edits only within a matching Git context", async () => {
  await withPolicyFleet(
    { mode: "default-branch", branch: "master" },
    async (source, target) => {
      const targetHead = git(target.root, "rev-parse", "HEAD");
      writeFileSync(
        join(source.root, "source.ts"),
        "export const value = 2;\n",
      );
      synced(await syncFolderV3(source));
      synced(await syncFolderV3(target));
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        "export const value = 2;\n",
      );
      assert.equal(git(target.root, "rev-parse", "HEAD"), targetHead);

      // A normal editor's atomic save keeps the logical file, not its old inode.
      writeFileSync(
        join(source.root, "atomic-save.tmp"),
        "export const value = 22;\n",
      );
      renameSync(
        join(source.root, "atomic-save.tmp"),
        join(source.root, "source.ts"),
      );
      assert.equal((await syncFolderV3(source)).status, "clean");
      assert.equal((await syncFolderV3(target)).status, "clean");
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        "export const value = 22;\n",
      );

      // A checkout after upload cannot authorize an event in the wrong context.
      const beforeRace = await statusV3(target);
      writeFileSync(
        join(target.root, "source.ts"),
        "export const uploadRace = true;\n",
      );
      const uploadRace = await syncFolderV3(target, {
        fault(point) {
          if (point === "after-upload")
            git(target.root, "switch", "-c", "upload-race");
        },
      });
      assert.equal(uploadRace.status, "inconclusive");
      const queuedRace = await statusV3(target);
      assert.equal(queuedRace.hubSequence, beforeRace.hubSequence);
      assert.equal(queuedRace.outboxEntries, 1);
      assert.equal(
        git(target.root, "symbolic-ref", "--short", "HEAD"),
        "upload-race",
      );
      assert.equal((await syncFolderV3(target)).status, "inconclusive");
      git(target.root, "switch", "master");
      assert.equal((await syncFolderV3(target)).status, "clean");
      assert.equal((await syncFolderV3(source)).status, "clean");
      assert.equal(
        readFileSync(join(source.root, "source.ts"), "utf8"),
        "export const uploadRace = true;\n",
      );

      writeFileSync(
        join(source.root, "source.ts"),
        "export const value = 20;\n",
      );
      synced(await syncFolderV3(source));
      let attemptedCheckout = false;
      const applied = await syncFolderV3(target, {
        fault(point) {
          if (point !== "after-apply-journal") return;
          attemptedCheckout = true;
          const checkout = spawnSync(
            "git",
            ["-C", target.root, "switch", "-c", "racing-checkout"],
            { encoding: "utf8" },
          );
          assert.notEqual(checkout.status, 0);
        },
      });
      synced(applied);
      assert.equal(attemptedCheckout, true);
      assert.equal(
        git(target.root, "symbolic-ref", "--short", "HEAD"),
        "master",
      );
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        "export const value = 20;\n",
      );

      writeFileSync(
        join(source.root, "source.ts"),
        "export const value = 21;\n",
      );
      synced(await syncFolderV3(source));
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import { loadConfig } from './src/v3/config.ts';
        import { syncFolderV3 } from './src/v3/engine.ts';
        const config = loadConfig(process.argv[1]);
        await syncFolderV3(config, { fault(point) {
          if (point === 'after-apply-journal') process.kill(process.pid, 'SIGKILL');
        }});
      `,
          join(target.root, ".codefoldersync", "config.json"),
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);
      synced(await syncFolderV3(target));
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        "export const value = 21;\n",
      );
      assert.equal(git(target.root, "rev-parse", "HEAD"), targetHead);
      git(target.root, "switch", "-c", "post-recovery-checkout");
      git(target.root, "switch", "master");

      const pausedRoot = join(target.root, "packages", "paused");
      const healthyPath = "packages/healthy/source.ts";
      const innerPath = "packages/paused/inner/source.ts";
      git(pausedRoot, "switch", "-c", "private-feature");
      writeFileSync(
        join(pausedRoot, "source.ts"),
        "export const privateFeature = true;\n",
      );
      git(pausedRoot, "add", "source.ts");
      const privateIndex = readFileSync(join(pausedRoot, ".git", "index"));
      writeFileSync(
        join(source.root, "packages", "paused", "source.ts"),
        "export const pausedSourceEdit = true;\n",
      );
      writeFileSync(
        join(source.root, healthyPath),
        "export const healthySourceEdit = true;\n",
      );
      writeFileSync(
        join(source.root, innerPath),
        "export const innerSourceEdit = true;\n",
      );
      synced(await syncFolderV3(source));
      let attemptedParentCheckout = false;
      const partial = await syncFolderV3(target, {
        fault(point) {
          if (point !== "after-apply-journal") return;
          attemptedParentCheckout = true;
          const checkout = spawnSync(
            "git",
            ["-C", pausedRoot, "switch", "master"],
            { encoding: "utf8" },
          );
          assert.notEqual(checkout.status, 0);
        },
      });
      assert.equal(partial.status, "inconclusive", JSON.stringify(partial));
      assert.equal(partial.applied, true, JSON.stringify(partial));
      assert.equal(attemptedParentCheckout, true);
      assert.equal(
        readFileSync(join(target.root, healthyPath), "utf8"),
        "export const healthySourceEdit = true;\n",
      );
      assert.equal(
        readFileSync(join(target.root, innerPath), "utf8"),
        "export const innerSourceEdit = true;\n",
      );
      assert.equal(
        readFileSync(join(pausedRoot, "source.ts"), "utf8"),
        "export const privateFeature = true;\n",
      );
      assert.deepEqual(
        readFileSync(join(pausedRoot, ".git", "index")),
        privateIndex,
      );
      assert.equal(
        git(pausedRoot, "symbolic-ref", "--short", "HEAD"),
        "private-feature",
      );
      assert.equal((await verifyFullV3(target)).status, "inconclusive");
      writeFileSync(
        join(source.root, innerPath),
        "export const innerRestartEdit = true;\n",
      );
      synced(await syncFolderV3(source));
      crashApplying(target);
      assert.equal((await syncFolderV3(target)).status, "inconclusive");
      assert.equal(
        readFileSync(join(target.root, innerPath), "utf8"),
        "export const innerRestartEdit = true;\n",
      );
      assert.deepEqual(
        readFileSync(join(pausedRoot, ".git", "index")),
        privateIndex,
      );
      writeFileSync(
        join(target.root, healthyPath),
        "export const healthyTargetEdit = true;\n",
      );
      assert.equal((await syncFolderV3(target)).published, true);
      synced(await syncFolderV3(source));
      assert.equal(
        readFileSync(join(source.root, healthyPath), "utf8"),
        "export const healthyTargetEdit = true;\n",
      );
      assert.equal(
        readFileSync(
          join(source.root, "packages", "paused", "source.ts"),
          "utf8",
        ),
        "export const pausedSourceEdit = true;\n",
      );
      git(pausedRoot, "restore", "--staged", "source.ts");
      git(pausedRoot, "restore", "source.ts");
      git(pausedRoot, "switch", "master");
      synced(await syncFolderV3(target));
      assert.equal(
        readFileSync(join(pausedRoot, "source.ts"), "utf8"),
        "export const pausedSourceEdit = true;\n",
      );

      // Stop after durable queueing, then change one repository's branch.
      writeFileSync(
        join(pausedRoot, "source.ts"),
        "export const queuedPausedEdit = true;\n",
      );
      writeFileSync(
        join(target.root, healthyPath),
        "export const queuedHealthyEdit = true;\n",
      );
      const interrupted = await syncFolderV3(target, {
        fault(point) {
          if (point === "after-outbox")
            throw new Error("Synthetic transport outage after durable queue");
        },
      });
      assert.equal(interrupted.status, "inconclusive");
      {
        using state = new LocalState(target);
        assert.equal(state.outbox().length, 1);
      }
      git(pausedRoot, "switch", "private-feature");
      writeFileSync(
        join(target.root, healthyPath),
        "export const newestHealthyEdit = true;\n",
      );
      const queuedPartial = await syncFolderV3(target);
      assert.equal(
        queuedPartial.published,
        true,
        JSON.stringify(queuedPartial),
      );
      {
        using state = new LocalState(target);
        assert.equal(state.outbox().length, 1);
      }
      synced(await syncFolderV3(source));
      assert.equal(
        readFileSync(join(source.root, healthyPath), "utf8"),
        "export const newestHealthyEdit = true;\n",
      );
      assert.equal(
        readFileSync(join(source.root, "packages/paused/source.ts"), "utf8"),
        "export const pausedSourceEdit = true;\n",
      );
      assert.equal(
        readFileSync(join(pausedRoot, "source.ts"), "utf8"),
        "export const queuedPausedEdit = true;\n",
      );
      writeFileSync(
        join(pausedRoot, "source.ts"),
        "export const pausedSourceEdit = true;\n",
      );
      git(pausedRoot, "switch", "master");
      synced(await syncFolderV3(target));
      {
        using state = new LocalState(target);
        assert.equal(state.outbox().length, 0);
      }
      assert.equal(
        readFileSync(join(target.root, healthyPath), "utf8"),
        "export const newestHealthyEdit = true;\n",
      );

      git(target.root, "switch", "-c", "feature");
      const featureCode = readFileSync(join(target.root, "source.ts"), "utf8");
      writeFileSync(
        join(source.root, "source.ts"),
        "export const value = 3;\n",
      );
      synced(await syncFolderV3(source));
      assert.equal((await syncFolderV3(target)).status, "inconclusive");
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        featureCode,
      );
      assert.equal(
        git(target.root, "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      git(target.root, "switch", "master");
      synced(await syncFolderV3(target));
      assert.equal(
        readFileSync(join(target.root, "source.ts"), "utf8"),
        "export const value = 3;\n",
      );
      git(target.root, "add", "source.ts");
      const scratch = join(target.root, "scratch");
      mkdirSync(scratch);
      git(scratch, "init", "-b", "unborn");
      writeFileSync(join(scratch, ".git", "index.lock"), "synthetic-lock\n");
      writeFileSync(
        join(scratch, "local.ts"),
        "export const localScratch = true;\n",
      );
      writeFileSync(
        join(source.root, healthyPath),
        "export const healthyBesideUnborn = true;\n",
      );
      synced(await syncFolderV3(source));
      const withUnborn = await syncFolderV3(target);
      assert.equal(withUnborn.status, "inconclusive");
      assert.equal(withUnborn.applied, true, JSON.stringify(withUnborn));
      assert.equal(
        readFileSync(join(target.root, healthyPath), "utf8"),
        "export const healthyBesideUnborn = true;\n",
      );
      assert.equal(
        readFileSync(join(scratch, "local.ts"), "utf8"),
        "export const localScratch = true;\n",
      );
      assert.equal(
        readFileSync(join(scratch, ".git", "index.lock"), "utf8"),
        "synthetic-lock\n",
      );
      writeFileSync(
        join(target.root, "source.ts"),
        "export const oldQueuedContext = 300;\n",
      );
      const oldQueued = await syncFolderV3(target, {
        fault(point) {
          if (point === "after-outbox")
            throw new Error("Synthetic outage before a commit transition");
        },
      });
      assert.equal(oldQueued.status, "inconclusive");
      {
        using state = new LocalState(target);
        assert.equal(state.outbox().length, 1);
      }
      writeFileSync(
        join(target.root, "source.ts"),
        "export const value = 3;\n",
      );
      writeFileSync(
        join(target.root, "committed.ts"),
        "export const committedThenDeleted = true;\n",
      );
      writeFileSync(
        join(target.root, "committed.bin"),
        Buffer.alloc(256 * 1024 + 77, 0x4b),
      );
      symlinkSync("source.ts", join(target.root, "committed.link"));
      git(
        target.root,
        "add",
        "source.ts",
        "committed.ts",
        "committed.bin",
        "committed.link",
      );
      git(target.root, "commit", "-m", "target advances independently");
      const advancedHead = git(target.root, "rev-parse", "HEAD");
      rmSync(join(target.root, "committed.ts"));
      writeFileSync(
        join(target.root, "source.ts"),
        "export const value = 4;\n",
      );
      const advanced = await syncFolderV3(target);
      assert.equal(advanced.published, true, JSON.stringify(advanced));
      {
        using state = new LocalState(target);
        assert.equal(state.outbox().length, 0);
        assert.equal(state.heldOutbox().length, 1);
        const held = state.heldOutbox()[0];
        assert.ok(held);
        const recovered = recoverHeldFileV3(target, held.eventId, "source.ts");
        assert.equal(
          readFileSync(recovered, "utf8"),
          "export const oldQueuedContext = 300;\n",
        );
        assert.equal(
          readFileSync(join(target.root, "source.ts"), "utf8"),
          "export const value = 4;\n",
        );
      }
      assert.equal(git(target.root, "rev-parse", "HEAD"), advancedHead);
      const olderPeer = await syncFolderV3(source);
      assert.equal(olderPeer.status, "inconclusive", JSON.stringify(olderPeer));
      assert.equal(
        readFileSync(join(source.root, "source.ts"), "utf8"),
        "export const value = 3;\n",
      );

      // Git advances independently. A clean new checkout receives only dirty work.
      git(source.root, "restore", "source.ts");
      git(source.root, "fetch", target.root, "master");
      git(source.root, "merge", "--ff-only", "FETCH_HEAD");
      const newIndex = readFileSync(join(source.root, ".git", "index"));
      const caughtUp = await syncFolderV3(source);
      synced(caughtUp);
      assert.equal(
        caughtUp.status,
        "clean",
        JSON.stringify(await statusV3(source)),
      );
      assert.equal(caughtUp.published, false);
      assert.equal(
        readFileSync(join(source.root, "source.ts"), "utf8"),
        "export const value = 4;\n",
      );
      assert.equal(git(source.root, "rev-parse", "HEAD"), advancedHead);
      assert.deepEqual(
        readFileSync(join(source.root, ".git", "index")),
        newIndex,
      );
      assert.deepEqual(
        readFileSync(join(source.root, "committed.bin")),
        Buffer.alloc(256 * 1024 + 77, 0x4b),
      );
      assert.equal(
        readFileSync(join(source.root, "committed.link"), "utf8"),
        "export const value = 4;\n",
      );
      assert.ok(
        git(source.root, "status", "--porcelain")
          .split("\n")
          .some((line) => line.endsWith("committed.ts")),
      );

      const addedPath = "packages/added";
      const addedSource = join(source.root, addedPath);
      const addedTarget = join(target.root, addedPath);
      mkdirSync(addedSource);
      git(addedSource, "init", "-b", "master");
      writeFileSync(join(addedSource, "new.ts"), "export const added = 1;\n");
      git(addedSource, "add", "new.ts");
      git(addedSource, "commit", "-m", "new independent repository");
      const addedHead = git(addedSource, "rev-parse", "HEAD");
      writeFileSync(join(addedSource, "new.ts"), "export const added = 2;\n");
      assert.equal((await syncFolderV3(source)).published, true);
      // Only the fixture performs clone/setup. Sync never creates Git metadata.
      git(join(target.root, "packages"), "clone", addedSource, "added");
      const addedIndex = readFileSync(join(addedTarget, ".git", "index"));
      assert.equal((await syncFolderV3(target)).applied, true);
      assert.equal(
        readFileSync(join(addedTarget, "new.ts"), "utf8"),
        "export const added = 2;\n",
      );
      assert.equal(git(addedTarget, "rev-parse", "HEAD"), addedHead);
      assert.deepEqual(
        readFileSync(join(addedTarget, ".git", "index")),
        addedIndex,
      );
      writeFileSync(join(addedTarget, "new.ts"), "export const added = 3;\n");
      assert.equal((await syncFolderV3(target)).published, true);
      assert.equal((await syncFolderV3(source)).status, "clean");
      assert.equal(
        readFileSync(join(addedSource, "new.ts"), "utf8"),
        "export const added = 3;\n",
      );
    },
  );
});
