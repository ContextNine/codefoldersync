import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFixture } from "../src/fixture.js";
import { git } from "../src/git.js";
import {
  history,
  listRecoveries,
  recoverSnapshot,
  resolveConflict,
  statusFolder,
  syncFolder,
} from "../src/product/engine.js";
import { scanUnit } from "../src/product/snapshot.js";
import { setupProduct } from "../src/product/setup.js";
import type { ProductConfig } from "../src/product/types.js";

test("native engine handles serial handoff and concurrent independent repositories", () => {
  withFleet((fleet) => {
    assertSuccessful(syncFolder(fleet.alpha));
    assertSuccessful(syncFolder(fleet.beta));
    assertSuccessful(syncFolder(fleet.gamma));
    assertFleetEqual(fleet, "atlas");

    writeAndCommit(fleet.alpha, "atlas", "serial.txt", "alpha serial\n");
    assertSuccessful(syncFolder(fleet.alpha));
    assertSuccessful(syncFolder(fleet.beta));
    assertSuccessful(syncFolder(fleet.gamma));
    assertFleetEqual(fleet, "atlas");

    writeAndCommit(fleet.alpha, "atlas", "parallel.txt", "alpha atlas\n");
    writeAndCommit(fleet.beta, "birch", "parallel.txt", "beta birch\n");
    assertSuccessful(syncFolder(fleet.alpha));
    assertSuccessful(syncFolder(fleet.beta));
    assertSuccessful(syncFolder(fleet.alpha));
    assertSuccessful(syncFolder(fleet.gamma));
    assertSuccessful(syncFolder(fleet.beta));
    assertFleetEqual(fleet, "atlas");
    assertFleetEqual(fleet, "birch");
    assert.equal(
      statusFolder(fleet.gamma).every((unit) => unit.status === "clean"),
      true,
    );
  });
});

test("same-repository concurrency is preserved, blocked, recoverable, and explicit", () => {
  withFleet((fleet) => {
    assertSuccessful(syncFolder(fleet.alpha));
    assertSuccessful(syncFolder(fleet.beta));
    assertSuccessful(syncFolder(fleet.gamma));

    writeAndCommit(fleet.alpha, "atlas", "src/shared.txt", "alpha decision\n");
    writeAndCommit(fleet.beta, "atlas", "src/shared.txt", "beta decision\n");
    assertSuccessful(syncFolder(fleet.alpha));
    const betaResult = syncFolder(fleet.beta);
    const blocked = betaResult.find((result) => result.unit === "atlas");
    assert.equal(blocked?.action, "blocked");
    assert.ok(blocked?.snapshotId);
    assert.equal(
      readFileSync(join(fleet.beta.root, "atlas", "src", "shared.txt"), "utf8"),
      "beta decision\n",
    );
    assert.equal(
      statusFolder(fleet.beta).find((unit) => unit.unit === "atlas")?.status,
      "blocked",
    );

    const snapshots = history(fleet.beta, "atlas");
    assert.equal(
      snapshots.some((snapshot) => snapshot.snapshotId === blocked.snapshotId),
      true,
    );
    const recovered = join(fleet.base, "recovered-beta");
    recoverSnapshot(fleet.beta, blocked.snapshotId, recovered);
    assert.equal(
      readFileSync(join(recovered, "src", "shared.txt"), "utf8"),
      "beta decision\n",
    );

    const resolution = resolveConflict(fleet.beta, "atlas", "remote");
    assert.equal(resolution.action, "applied");
    const recoveries = listRecoveries(fleet.beta).filter(
      (snapshot) => snapshot.unit === "atlas",
    );
    assert.ok(recoveries.length > 0);
    const localRecovery = recoveries.at(-1);
    assert.ok(localRecovery);
    const recoveredWithoutHub = join(fleet.base, "recovered-without-hub");
    recoverSnapshot(
      {
        ...fleet.beta,
        hub: { kind: "local", path: join(fleet.base, "unreachable-hub") },
      },
      localRecovery.snapshotId,
      recoveredWithoutHub,
    );
    assert.equal(
      readFileSync(join(recoveredWithoutHub, "src", "shared.txt"), "utf8"),
      "beta decision\n",
    );
    assertSuccessful(syncFolder(fleet.gamma));
    assertSuccessful(syncFolder(fleet.beta));
    assertFleetEqual(fleet, "atlas");
    assert.equal(
      readFileSync(join(fleet.beta.root, "atlas", "src", "shared.txt"), "utf8"),
      "alpha decision\n",
    );
  });
});

test("setup rejects a hub inside the synchronized root", () => {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-product-path-"));
  try {
    const root = join(base, "root");
    createFixture(root, 44102);
    assert.throws(
      () =>
        setupProduct({
          mode: "create",
          root,
          folderName: "unsafe",
          peerName: "alpha",
          stateDir: join(base, "state"),
          configPath: join(base, "config.json"),
          hub: { kind: "local", path: join(root, "hub") },
        }),
      /outside the synchronized root/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt immutable snapshot data is rejected", () => {
  withFleet((fleet) => {
    const initial = syncFolder(fleet.alpha);
    assertSuccessful(initial);
    const snapshotId = initial.find(
      (result) => result.unit === "atlas",
    )?.snapshotId;
    assert.ok(snapshotId);
    const snapshotPath = join(
      fleet.hub,
      fleet.alpha.folderId,
      "snapshots",
      `${snapshotId}.json`,
    );
    const value = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      files: Array<{ content: string }>;
    };
    const first = value.files[0];
    assert.ok(first);
    first.content = Buffer.from("corrupt").toString("base64");
    writeFileSync(snapshotPath, `${JSON.stringify(value)}\n`);
    assert.throws(() => history(fleet.alpha, "atlas"), /mismatch/u);
  });
});

interface Fleet {
  readonly base: string;
  readonly hub: string;
  readonly alpha: ProductConfig;
  readonly beta: ProductConfig;
  readonly gamma: ProductConfig;
}

function withFleet(action: (fleet: Fleet) => void): void {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-product-"));
  try {
    const hub = join(base, "hub");
    const alphaRoot = join(base, "alpha");
    createFixture(alphaRoot, 44101);
    const alpha = setupProduct({
      mode: "create",
      root: alphaRoot,
      folderName: "integration",
      peerName: "alpha",
      stateDir: join(base, "alpha-state"),
      configPath: join(base, "alpha.json"),
      hub: { kind: "local", path: hub },
    });
    const beta = joinFleet(base, hub, alpha, "beta");
    const gamma = joinFleet(base, hub, alpha, "gamma");
    action({ base, hub, alpha, beta, gamma });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function joinFleet(
  base: string,
  hub: string,
  source: ProductConfig,
  peerName: "beta" | "gamma",
): ProductConfig {
  return setupProduct({
    mode: "join",
    root: join(base, peerName),
    folderName: source.folderName,
    folderId: source.folderId,
    peerName,
    stateDir: join(base, `${peerName}-state`),
    configPath: join(base, `${peerName}.json`),
    hub: { kind: "local", path: hub },
  });
}

function writeAndCommit(
  config: ProductConfig,
  repository: "atlas" | "birch",
  relativePath: string,
  content: string,
): void {
  const repositoryPath = join(config.root, repository);
  writeFileSync(join(repositoryPath, ...relativePath.split("/")), content);
  git(repositoryPath, ["add", relativePath]);
  git(repositoryPath, ["commit", "-m", `${config.peerName}: ${relativePath}`]);
}

function assertSuccessful(results: ReturnType<typeof syncFolder>): void {
  assert.equal(
    results.every(
      (result) =>
        result.action !== "blocked" && result.action !== "inconclusive",
    ),
    true,
    JSON.stringify(results, null, 2),
  );
}

function assertFleetEqual(fleet: Fleet, unit: "atlas" | "birch"): void {
  const digests = [fleet.alpha, fleet.beta, fleet.gamma].map(
    (config) => scanUnit(join(config.root, unit)).treeDigest,
  );
  assert.equal(new Set(digests).size, 1, `${unit} did not converge`);
}
