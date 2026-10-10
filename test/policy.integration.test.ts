import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  planAdoptionV3,
  sealSourceV3,
  syncFolderV3,
  verifyFullV3,
} from "../src/v3/engine.js";
import { plaintextEnvPolicy } from "../src/v3/policy.js";
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

      git(target.root, "switch", "-c", "feature");
      const featureCode = readFileSync(join(target.root, "source.ts"), "utf8");
      writeFileSync(
        join(source.root, "source.ts"),
        "export const value = 3;\n",
      );
      synced(await syncFolderV3(source));
      await assert.rejects(syncFolderV3(target), /default branch.*paused/u);
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
      git(target.root, "commit", "-m", "target advances independently");
      const advancedHead = git(target.root, "rev-parse", "HEAD");
      const paused = await syncFolderV3(target);
      assert.equal(paused.status, "inconclusive");
      assert.match(paused.reasons.join(" "), /HEAD differs/u);
      assert.equal(git(target.root, "rev-parse", "HEAD"), advancedHead);
    },
  );
});
