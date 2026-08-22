import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  recoverManifestV2,
  resolveGitConflictV2,
  statusV2,
  syncFolderV2,
} from "../src/v2/engine.js";
import { ObjectStore } from "../src/v2/objects.js";
import {
  activateInstalledVersion,
  installSelf,
  installService,
} from "../src/v2/service.js";
import { addRepositoryV2, removeRepositoryV2 } from "../src/v2/membership.js";
import { setupProductV2 } from "../src/v2/setup.js";
import type { ProductConfig } from "../src/v2/types.js";

test("V2 incrementally joins large files, executable files, and exact symlinks", async () => {
  await withFleet(async (fleet) => {
    const source = join(fleet.alpha.root, "atlas");
    const large = Buffer.alloc(16 * 1024 * 1024, 0x61);
    writeFileSync(join(source, "large.bin"), large);
    writeFileSync(join(source, "tool.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    symlinkSync("missing-target", join(source, "broken-link"));
    assertClean(await syncFolderV2(fleet.alpha));
    assertClean(await syncFolderV2(fleet.beta));
    assert.equal(
      readlinkSync(join(fleet.beta.root, "atlas", "broken-link")),
      "missing-target",
    );
    assert.notEqual(
      lstatSync(join(fleet.beta.root, "atlas", "tool.sh")).mode & 0o111,
      0,
    );
    assert.deepEqual(
      readFileSync(join(fleet.beta.root, "atlas", "large.bin")),
      large,
    );

    const descriptor = openSync(join(source, "large.bin"), "r+");
    try {
      writeSync(
        descriptor,
        Buffer.from("incremental-middle-edit"),
        0,
        23,
        8 * 1024 * 1024,
      );
    } finally {
      closeSync(descriptor);
    }
    const published = await syncFolderV2(fleet.alpha);
    assertClean(published);
    assert.ok(
      published.uploadedBytes < 8 * 1024 * 1024,
      JSON.stringify(published),
    );
    assertClean(await syncFolderV2(fleet.beta));
    assert.deepEqual(
      readFileSync(join(fleet.beta.root, "atlas", "large.bin")),
      readFileSync(join(source, "large.bin")),
    );

    const interruptedRoot = join(fleet.base, "interrupted", "code");
    const interruptedSetup = await setupProductV2({
      mode: "join",
      folderId: fleet.alpha.folderId,
      root: interruptedRoot,
      folderName: fleet.alpha.folderName,
      peerName: "interrupted",
      stateDir: join(fleet.base, "interrupted", "state"),
      configPath: join(fleet.base, "interrupted", "config.json"),
      hub: { kind: "local", path: fleet.hub },
      initialSync: false,
    });
    mkdirSync(join(interruptedRoot, "atlas"), { recursive: true });
    writeFileSync(
      join(interruptedRoot, "atlas", "README.md"),
      "partial local\n",
    );
    assertClean(await syncFolderV2(interruptedSetup.config));
    assert.equal(
      readFileSync(join(interruptedRoot, "atlas", "README.md"), "utf8"),
      readFileSync(join(source, "README.md"), "utf8"),
    );
    assert.equal(
      findFileContaining(
        join(interruptedSetup.config.stateDir, "recovery"),
        "partial local\n",
      ),
      true,
    );
    const unchanged = await syncFolderV2(fleet.alpha);
    assert.equal(unchanged.uploadedObjects, 0);
    assert.equal(unchanged.published, 0);
  });
});

test("V2 converges deterministic keep-both conflicts and metadata-only directory moves", async () => {
  await withFleet(async (fleet) => {
    for (const peer of [fleet.alpha, fleet.beta, fleet.gamma])
      assertClean(await syncFolderV2(peer));
    const alpha = join(fleet.alpha.root, "atlas");
    const beta = join(fleet.beta.root, "atlas");
    writeFileSync(join(alpha, "shared.ts"), "alpha version\n");
    writeFileSync(join(beta, "shared.ts"), "beta version\n");
    assertClean(await syncFolderV2(fleet.alpha));
    const betaConflict = await syncFolderV2(fleet.beta);
    assert.equal(betaConflict.status, "conflict");
    await syncFolderV2(fleet.alpha);
    await syncFolderV2(fleet.gamma);
    const conflictNames = readdirSync(alpha).filter((name) =>
      name.includes("CODEFOLDERSYNC-CONFLICT"),
    );
    assert.equal(conflictNames.length, 1);
    const conflictName = conflictNames[0];
    assert.ok(conflictName);
    for (const peer of [fleet.alpha, fleet.beta, fleet.gamma]) {
      const root = join(peer.root, "atlas");
      assert.equal(
        readFileSync(join(root, "shared.ts"), "utf8"),
        "alpha version\n",
      );
      assert.equal(
        readFileSync(join(root, conflictName), "utf8"),
        "beta version\n",
      );
    }

    mkdirSync(join(alpha, "moving"));
    writeFileSync(join(alpha, "moving", "child.txt"), "before\n");
    await syncAll(fleet);
    renameSync(join(alpha, "moving"), join(alpha, "moved"));
    writeFileSync(join(beta, "moving", "child.txt"), "edited during rename\n");
    assertClean(await syncFolderV2(fleet.alpha));
    assertClean(await syncFolderV2(fleet.beta));
    await syncFolderV2(fleet.alpha);
    await syncFolderV2(fleet.gamma);
    for (const peer of [fleet.alpha, fleet.beta, fleet.gamma]) {
      assert.equal(
        readFileSync(join(peer.root, "atlas", "moved", "child.txt"), "utf8"),
        "edited during rename\n",
      );
      assert.equal(existsSync(join(peer.root, "atlas", "moving")), false);
    }
  });
});

test("V2 preserves concurrent Git states and rejects corrupt immutable objects", async () => {
  await withFleet(async (fleet) => {
    await syncAll(fleet);
    commitFile(fleet.alpha, "atlas", "alpha-commit.txt", "alpha commit\n");
    commitFile(fleet.beta, "atlas", "beta-commit.txt", "beta commit\n");
    const betaHead = git(join(fleet.beta.root, "atlas"), ["rev-parse", "HEAD"]);
    assertClean(await syncFolderV2(fleet.alpha));
    const beta = await syncFolderV2(fleet.beta);
    assert.equal(beta.status, "conflict");
    const betaStatus = await import("../src/v2/engine.js").then(
      ({ statusV2 }) => statusV2(fleet.beta),
    );
    const gitConflict = betaStatus.conflicts.find(
      (value) => value.kind === "git",
    );
    assert.ok(gitConflict?.manifestId);
    const recovered = join(fleet.base, "recovered-git");
    await recoverManifestV2(fleet.beta, gitConflict.manifestId, recovered);
    verifyGitDirectory(recovered);
    const resolved = await resolveGitConflictV2(
      fleet.beta,
      gitConflict.conflictId,
      "conflict",
    );
    assert.notEqual(resolved.status, "inconclusive", JSON.stringify(resolved));
    await syncFolderV2(fleet.alpha);
    await syncFolderV2(fleet.gamma);
    assert.equal(
      git(join(fleet.alpha.root, "atlas"), ["rev-parse", "HEAD"]),
      betaHead,
    );

    const localStore = new ObjectStore(join(fleet.beta.stateDir, "objects"));
    const corruptId = gitConflict.manifestId;
    using hubDatabase = new DatabaseSync(
      join(fleet.hub, "objects", "objects.sqlite"),
    );
    hubDatabase
      .prepare("UPDATE objects SET bytes = ? WHERE id = ?")
      .run(Buffer.from("corrupt"), corruptId);
    using hubStore = new ObjectStore(join(fleet.hub, "objects"));
    assert.throws(() => hubStore.get(corruptId), /Corrupt object/u);
    assert.ok(localStore.has(corruptId));
  });
});

test("V2 setup and service installation stay inside explicit paths", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v2-install-"));
  try {
    const root = join(base, "code");
    createRepository(join(root, "atlas"));
    await assert.rejects(
      setupProductV2({
        mode: "create",
        root,
        folderName: "unsafe",
        peerName: "alpha",
        stateDir: join(base, "state-unsafe"),
        configPath: join(base, "unsafe.json"),
        hub: { kind: "local", path: join(root, "hub") },
      }),
      /outside the synchronized root/u,
    );
    assert.equal(existsSync(join(root, "hub")), false);

    const created = await setupProductV2({
      mode: "create",
      root,
      folderName: "install",
      peerName: "alpha",
      stateDir: join(base, "state"),
      configPath: join(base, "config.json"),
      hub: { kind: "local", path: join(base, "hub") },
    });
    const definitionDirectory = join(base, "service-definitions");
    const service = installService(created.config, {
      configPath: join(base, "config.json"),
      executablePath: process.execPath,
      scriptPath: join(process.cwd(), "src", "product-cli.ts"),
      definitionDirectory,
      activate: false,
    });
    assert.equal(service.installed, true);
    assert.equal(service.definitionPath.startsWith(definitionDirectory), true);
    const definition = readFileSync(service.definitionPath, "utf8");
    assert.match(definition, /CodeFolderSync|codefoldersync/u);
    assert.match(definition, /daemon/u);
    assert.match(
      definition,
      new RegExp(escapeRegExp(join(base, "config.json")), "u"),
    );

    const built = join(base, "built");
    mkdirSync(built);
    writeFileSync(
      join(built, "product-cli.js"),
      "process.stdout.write('ok\\n')\n",
    );
    const installation = installSelf({
      builtDirectory: built,
      installRoot: join(base, "installed"),
      binaryDirectory: join(base, "bin"),
    });
    assert.equal(installation.executable.startsWith(base), true);
    assert.equal(existsSync(installation.executable), true);
    assert.equal(
      activateInstalledVersion({
        version: "0.2.1",
        installRoot: join(base, "installed"),
        binaryDirectory: join(base, "bin"),
      }).executable,
      installation.executable,
    );

    createRepository(join(root, "birch"));
    const withBirch = await addRepositoryV2(
      created.config,
      join(base, "config.json"),
      "birch",
    );
    assertClean(await syncFolderV2(withBirch));
    const withoutBirch = await removeRepositoryV2(
      withBirch,
      join(base, "config.json"),
      "birch",
    );
    assert.equal(
      withoutBirch.repositories.some((value) => value.name === "birch"),
      false,
    );
    assert.equal(existsSync(join(root, "birch", ".git")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("V2 watcher daemons propagate a saved file immediately over one persistent session", async () => {
  await withFleet(async (fleet) => {
    const alphaDaemon = startDaemon(join(fleet.base, "alpha", "config.json"));
    const betaDaemon = startDaemon(join(fleet.base, "beta", "config.json"));
    try {
      await delay(300);
      const duplicateWriter = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "src", "product-cli.ts"),
          "sync",
          "--config",
          join(fleet.base, "alpha", "config.json"),
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(duplicateWriter.status, 2);
      assert.match(duplicateWriter.stderr, /daemon is already running/u);
      const started = Date.now();
      writeFileSync(
        join(fleet.alpha.root, "atlas", "instant.txt"),
        "saved now\n",
      );
      await waitFor(
        () =>
          existsSync(join(fleet.beta.root, "atlas", "instant.txt")) &&
          readFileSync(
            join(fleet.beta.root, "atlas", "instant.txt"),
            "utf8",
          ) === "saved now\n",
        5_000,
      );
      assert.ok(
        Date.now() - started < 2_000,
        `save took ${Date.now() - started}ms`,
      );

      // The receiver can observe a hub commit before the publisher finishes
      // advancing its local causal baseline. Saving the next version in that
      // window must publish normally rather than create a false conflict.
      for (let version = 0; version < 10; version += 1) {
        const content = `rapid version ${version}\n`;
        writeFileSync(join(fleet.alpha.root, "atlas", "instant.txt"), content);
        await waitFor(
          () =>
            existsSync(join(fleet.beta.root, "atlas", "instant.txt")) &&
            readFileSync(
              join(fleet.beta.root, "atlas", "instant.txt"),
              "utf8",
            ) === content,
          5_000,
        );
      }
      await delay(300);
      assert.equal((await statusV2(fleet.alpha)).conflicts.length, 0);
      assert.equal((await statusV2(fleet.beta)).conflicts.length, 0);
      assert.deepEqual(
        readdirSync(join(fleet.beta.root, "atlas")).filter((name) =>
          name.includes("CODEFOLDERSYNC-CONFLICT"),
        ),
        [],
      );
    } finally {
      alphaDaemon.kill("SIGTERM");
      betaDaemon.kill("SIGTERM");
      await Promise.all([once(alphaDaemon, "exit"), once(betaDaemon, "exit")]);
    }
  });
});

interface Fleet {
  readonly base: string;
  readonly hub: string;
  readonly alpha: ProductConfig;
  readonly beta: ProductConfig;
  readonly gamma: ProductConfig;
}

async function withFleet(
  action: (fleet: Fleet) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v2-product-"));
  try {
    const hub = join(base, "hub");
    const alphaRoot = join(base, "alpha", "code");
    createRepository(join(alphaRoot, "atlas"));
    writeFileSync(join(alphaRoot, "atlas", "shared.ts"), "baseline\n");
    git(join(alphaRoot, "atlas"), ["add", "."]);
    git(join(alphaRoot, "atlas"), ["commit", "-m", "fixture"]);
    const alphaResult = await setupProductV2({
      mode: "create",
      root: alphaRoot,
      folderName: "integration",
      peerName: "alpha",
      stateDir: join(base, "alpha", "state"),
      configPath: join(base, "alpha", "config.json"),
      hub: { kind: "local", path: hub },
    });
    const beta = await joinPeer(base, hub, alphaResult.config, "beta");
    const gamma = await joinPeer(base, hub, alphaResult.config, "gamma");
    await action({ base, hub, alpha: alphaResult.config, beta, gamma });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function joinPeer(
  base: string,
  hub: string,
  source: ProductConfig,
  peer: "beta" | "gamma",
): Promise<ProductConfig> {
  const result = await setupProductV2({
    mode: "join",
    folderId: source.folderId,
    root: join(base, peer, "code"),
    folderName: source.folderName,
    peerName: peer,
    stateDir: join(base, peer, "state"),
    configPath: join(base, peer, "config.json"),
    hub: { kind: "local", path: hub },
  });
  return result.config;
}

async function syncAll(fleet: Fleet): Promise<void> {
  for (const peer of [fleet.alpha, fleet.beta, fleet.gamma])
    assertClean(await syncFolderV2(peer));
}

function assertClean(result: Awaited<ReturnType<typeof syncFolderV2>>): void {
  assert.notEqual(result.status, "offline", JSON.stringify(result));
  assert.notEqual(result.status, "inconclusive", JSON.stringify(result));
}

function createRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
}

function commitFile(
  config: ProductConfig,
  repository: string,
  path: string,
  content: string,
): void {
  const root = join(config.root, repository);
  writeFileSync(join(root, path), content);
  git(root, ["add", path]);
  git(root, ["commit", "-m", `${config.peerName}: ${path}`]);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "user.name=CodeFolderSync Test",
      "-c",
      "user.email=codefoldersync@invalid.example",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function verifyGitDirectory(path: string): void {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", `--git-dir=${path}`, "fsck", "--full"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findFileContaining(root: string, expected: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (findFileContaining(path, expected)) return true;
      continue;
    }
    if (entry.isFile() && readFileSync(path, "utf8") === expected) return true;
  }
  return false;
}

function startDaemon(configPath: string) {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(process.cwd(), "src", "product-cli.ts"),
      "daemon",
      "--config",
      configPath,
      "--interval-ms",
      "50",
      "--poll-ms",
      "100",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`Condition did not become true within ${timeoutMs}ms`);
}
