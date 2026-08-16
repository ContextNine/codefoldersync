import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncFolderV2 } from "../src/v2/engine.js";
import { setupProductV2 } from "../src/v2/setup.js";
import type { ProductConfig } from "../src/v2/types.js";

test("V2 three-peer churn converges many incremental edits without touching ~/Code", async () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v2-native-live-"));
  try {
    assert.equal(base.includes("/Code/"), false);
    const alphaRoot = join(base, "alpha", "workspace");
    for (const repository of ["atlas", "birch", "coral"]) {
      createRepository(join(alphaRoot, repository), repository);
      for (let index = 0; index < 120; index += 1) {
        writeFileSync(
          join(alphaRoot, repository, `file-${index}.txt`),
          `${repository} baseline ${index}\n`,
        );
      }
      git(join(alphaRoot, repository), ["add", "."]);
      git(join(alphaRoot, repository), ["commit", "-m", "large fixture"]);
    }
    const hub = join(base, "hub");
    const alpha = (
      await setupProductV2({
        mode: "create",
        root: alphaRoot,
        folderName: "native-live",
        peerName: "alpha",
        stateDir: join(base, "alpha", "state"),
        configPath: join(base, "alpha", "config.json"),
        hub: { kind: "local", path: hub },
      })
    ).config;
    const beta = await joinPeer(base, hub, alpha, "beta");
    const gamma = await joinPeer(base, hub, alpha, "gamma");

    churn(alpha, "atlas", "alpha");
    churn(beta, "birch", "beta");
    churn(gamma, "coral", "gamma");
    for (const peer of [alpha, beta, gamma, alpha, beta, gamma]) {
      const result = await syncFolderV2(peer);
      assert.notEqual(result.status, "inconclusive", JSON.stringify(result));
      assert.notEqual(result.status, "offline", JSON.stringify(result));
    }
    for (const repository of ["atlas", "birch", "coral"]) {
      const digests = [alpha, beta, gamma].map((peer) =>
        worktreeDigest(join(peer.root, repository)),
      );
      assert.equal(
        new Set(digests).size,
        1,
        `${repository} worktrees diverged`,
      );
      const heads = [alpha, beta, gamma].map((peer) =>
        git(join(peer.root, repository), ["rev-parse", "HEAD"]),
      );
      assert.equal(new Set(heads).size, 1, `${repository} Git heads diverged`);
      for (const peer of [alpha, beta, gamma]) {
        git(join(peer.root, repository), ["fsck", "--full"]);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

async function joinPeer(
  base: string,
  hub: string,
  source: ProductConfig,
  peer: "beta" | "gamma",
): Promise<ProductConfig> {
  return (
    await setupProductV2({
      mode: "join",
      folderId: source.folderId,
      root: joinPath(base, peer, "workspace"),
      folderName: source.folderName,
      peerName: peer,
      stateDir: joinPath(base, peer, "state"),
      configPath: joinPath(base, peer, "config.json"),
      hub: { kind: "local", path: hub },
    })
  ).config;
}

function churn(config: ProductConfig, repository: string, peer: string): void {
  const root = join(config.root, repository);
  for (let index = 0; index < 120; index += 1) {
    const path = join(root, `file-${index}.txt`);
    if (index % 6 === 0) {
      writeFileSync(path, `${peer} replaced ${index}\n`);
    } else if (index % 6 === 1) {
      writeFileSync(path, `${readFileSync(path, "utf8")}${peer} appended\n`);
    } else if (index % 6 === 2) {
      renameSync(path, join(root, `renamed-${index}.txt`));
    } else if (index % 6 === 3) {
      rmSync(path);
    } else if (index % 6 === 4) {
      writeFileSync(path, `${peer} executable ${index}\n`, { mode: 0o755 });
    } else {
      const link = join(root, `link-${index}`);
      if (!existsSync(link)) symlinkSync(`file-${index - 1}.txt`, link);
    }
  }
  writeFileSync(join(root, `${peer}-commit.txt`), `${peer} commit\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", `${peer} churn`]);
}

function createRepository(path: string, name: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init"]);
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
}

function worktreeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (prefix.length === 0 && name === ".git") continue;
      const path = join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hash.update(`d\0${relative}\0`);
        walk(path, relative);
      } else if (stat.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${readlinkSync(path)}\0`);
      } else {
        hash.update(`f\0${relative}\0${stat.mode & 0o111}\0`);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
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

function joinPath(...parts: readonly string[]): string {
  return join(...parts);
}
