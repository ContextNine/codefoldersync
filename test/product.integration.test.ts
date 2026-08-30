import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nodeTest from "node:test";
import {
  activatePeerProjection,
  authorityPrivateKey,
  createAuthorityConfig,
  createPeerEnrollmentRequest,
  enrollPeer,
  ensureIgnore,
  loadConfig,
  peerPrivateKey,
  reviseConfig,
  signPayload,
} from "../src/v3/config.js";
import { manifestObjectIds, scanNamespace } from "../src/v3/catalog.js";
import {
  HubStore,
  adoptionVerificationPayload,
  conflictPayload,
  snapshotPayload,
} from "../src/v3/hub.js";
import { compileIgnore, defaultIgnore } from "../src/v3/ignore.js";
import {
  acceptIgnoreRevisionV3,
  type AdoptionFaultPoint,
  type CutoverFaultPoint,
  type NormalApplyFaultPoint,
  type SealFaultPoint,
  applyAdoptionV3,
  cutoverAdoptionV3,
  planAdoptionV3,
  previewIgnoreRevisionV3,
  recoverConflictV3,
  sealSourceV3,
  statusV3,
  syncFolderV3,
  verifyFullV3,
} from "../src/v3/engine.js";
import { LocalState } from "../src/v3/state.js";
import {
  activatePeerV3,
  type AuthoritySetupFaultPoint,
  enrollPeerV3,
  type EnrollmentFaultPoint,
  preparePeerEnrollment,
  type ProjectionFaultPoint,
  setupAuthorityV3,
} from "../src/v3/setup.js";
import type { PeerEnrollmentRequest } from "../src/v3/config.js";
import type {
  ConflictRecord,
  ProductConfig,
  SignedAdoptionVerification,
  SignedConflict,
  SignedSnapshot,
} from "../src/v3/types.js";
import { HubTransport } from "../src/v3/transport.js";
import { ObjectStore } from "../src/v3/objects.js";
import { deriveMutations } from "../src/v3/mutations.js";
import { promptFleetSetupSpecV3 } from "../src/v3/orchestrator.js";

interface ScenarioContext {
  readonly test: (
    name: string,
    action: () => void | Promise<void>,
  ) => Promise<void>;
}

const scenarios: {
  readonly group: string;
  readonly name: string;
  readonly action: (context: ScenarioContext) => Promise<void>;
}[] = [];

function scenario(
  group: string,
  name: string,
  action: (context: ScenarioContext) => Promise<void>,
): void {
  scenarios.push({ group, name, action });
}

scenario(
  "adoption",
  "recursively adopts two populated targets without mutating the source",
  async () => {
    await withFleet(async (fleet) => {
      const sourceBefore = await verifyFullV3(fleet.authority);
      assert.equal(sourceBefore.status, "clean", JSON.stringify(sourceBefore));

      for (const target of [fleet.beta, fleet.gamma]) {
        const plan = await planAdoptionV3(target.config);
        assert.ok(plan.summary["target-only"] > 0);
        assert.ok(plan.summary.divergent > 0);
        assert.ok(plan.summary["moved-equivalent"] > 0);
        assert.doesNotMatch(
          readFileSync(
            join(target.stateDir, "plans", `${plan.adoptionId}.json`),
            "utf8",
          ),
          /target-only\.txt/u,
        );
        const applied = await applyAdoptionV3(target.config, plan.adoptionId);
        assert.notEqual(
          applied.status,
          "inconclusive",
          JSON.stringify(applied),
        );
        assert.equal(
          readFileSync(join(target.config.root, "canonical.txt"), "utf8"),
          "same bytes at another path\n",
        );
        assert.equal(
          existsSync(join(target.config.root, "moved-target.txt")),
          false,
        );
        assert.equal(
          readFileSync(join(target.config.root, "notes.txt"), "utf8"),
          "source notes\n",
        );
        assert.equal(
          readlinkSync(join(target.config.root, "broken-link")),
          "missing-target",
        );
        assert.equal(
          readlinkSync(join(target.config.root, "absolute-link")),
          "/definitely/missing",
        );
        assert.notEqual(
          lstatSync(join(target.config.root, "tool.sh")).mode & 0o111,
          0,
        );
        assert.equal(
          readFileSync(join(target.config.root, "kind-swap"), "utf8"),
          "source file\n",
        );
        assert.equal(
          readFileSync(
            join(target.config.root, ".workspace-sync", "state.json"),
            "utf8",
          ),
          `${target.name} local control\n`,
        );
        assert.equal(
          readFileSync(
            join(
              target.config.root,
              "clients",
              "app",
              "node_modules",
              "local.txt",
            ),
            "utf8",
          ),
          `${target.name} ignored dependency\n`,
        );
        const conflicts = (await statusV3(target.config)).conflicts.filter(
          (conflict) => conflict.peerId === target.config.peerId,
        );
        assert.ok(conflicts.length >= 2);
        assert.ok(
          conflicts.every((conflict) => entryExists(conflict.recoveryPath)),
        );
        const targetTreeConflict = conflicts.find(
          (conflict) => conflict.originalPath === "target-tree",
        );
        assert.ok(targetTreeConflict);
        const recoveredTree = join(fleet.base, `${target.name}-recovered-tree`);
        recoverConflictV3(
          target.config,
          targetTreeConflict.conflictId,
          recoveredTree,
        );
        assert.equal(
          readFileSync(join(recoveredTree, "child", "target.txt"), "utf8"),
          `${target.name} subtree\n`,
        );
        const conflictIds = conflicts
          .map((conflict) => conflict.conflictId)
          .sort();
        const resumed = await applyAdoptionV3(target.config, plan.adoptionId);
        assert.equal(resumed.applied, false, JSON.stringify(resumed));
        const afterResume = (await statusV3(target.config)).conflicts
          .filter((conflict) => conflict.peerId === target.config.peerId)
          .map((conflict) => conflict.conflictId)
          .sort();
        assert.deepEqual(afterResume, conflictIds);
        assert.equal(
          git(join(target.config.root, "clients", "app"), [
            "rev-parse",
            "HEAD",
          ]),
          git(join(fleet.authority.root, "clients", "app"), [
            "rev-parse",
            "HEAD",
          ]),
        );
        assert.equal((await verifyFullV3(target.config)).status, "clean");
      }

      const sourceAfter = await verifyFullV3(fleet.authority);
      assert.equal(sourceAfter.status, "clean", JSON.stringify(sourceAfter));
      assert.equal(sourceAfter.hubSequence, sourceBefore.hubSequence);
      assert.equal(fleet.authority.hub.kind, "local");
      if (fleet.authority.hub.kind === "local") {
        const offlineHub = `${fleet.authority.hub.path}-offline`;
        renameSync(fleet.authority.hub.path, offlineHub);
        try {
          const offline = await statusV3(fleet.authority);
          assert.equal(offline.hubReachable, false);
          assert.equal(offline.hubSequence, null);
          assert.equal(offline.lifecycle, "adoption");
          assert.ok(offline.hubError);
        } finally {
          rmSync(fleet.authority.hub.path, { recursive: true, force: true });
          renameSync(offlineHub, fleet.authority.hub.path);
        }
      }
    });
  },
);

scenario(
  "setup",
  "scriptable setup adopts a populated fleet to verified disabled services in one call",
  async () => {
    const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-orchestrator-"));
    try {
      const authorityRoot = join(base, "authority", "code");
      const betaRoot = join(base, "beta", "code");
      const gammaRoot = join(base, "gamma", "code");
      createSourceTree(authorityRoot);
      createTargetTree(betaRoot, "beta");
      createTargetTree(gammaRoot, "gamma");
      const answers = [
        "orchestrated",
        "verified-test-witness",
        join(base, "hub"),
        authorityRoot,
        "authority",
        join(base, "authority", "state"),
        join(authorityRoot, ".codefoldersync", "config.json"),
        "2",
        betaRoot,
        join(base, "beta", "state"),
        "peer",
        "beta",
        join(betaRoot, ".codefoldersync", "config.json"),
        join(base, "beta", "request.json"),
        gammaRoot,
        join(base, "gamma", "state"),
        "peer",
        "gamma",
        join(gammaRoot, ".codefoldersync", "config.json"),
        join(base, "gamma", "request.json"),
        "yes",
      ];
      const spec = await promptFleetSetupSpecV3(async () => {
        const answer = answers.shift();
        assert.notEqual(answer, undefined);
        return answer ?? "";
      });
      assert.equal(answers.length, 0);
      assert.equal(spec.targets.length, 2);
      const specPath = join(base, "fleet-setup.json");
      writeFileSync(specPath, JSON.stringify(spec));
      const cli = join(process.cwd(), "src", "product-cli.ts");
      const setup = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          cli,
          "setup",
          "--mode",
          "fleet",
          "--spec",
          specPath,
          "--approve",
        ],
        { encoding: "utf8" },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const result = JSON.parse(setup.stdout) as {
        readonly lifecycle: string;
        readonly cutoverReady: boolean;
        readonly servicesEnabled: boolean;
        readonly targets: readonly unknown[];
      };
      assert.equal(result.lifecycle, "adoption");
      assert.equal(result.cutoverReady, true);
      assert.equal(result.servicesEnabled, false);
      assert.equal(result.targets.length, 2);
      const authority = loadConfig(spec.authority.configPath);
      assert.equal((await statusV3(authority)).verifiedAdoptionPeers.length, 2);
      for (const target of spec.targets)
        assert.equal(
          (await verifyFullV3(loadConfig(target.configPath))).status,
          "clean",
        );
      const serviceDirectory = join(base, "services");
      const authorityConfig = join(
        authorityRoot,
        ".codefoldersync",
        "config.json",
      );
      const prematureService = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          cli,
          "service",
          "install",
          "--activate",
          "--config",
          authorityConfig,
          "--definition-dir",
          serviceDirectory,
        ],
        { encoding: "utf8" },
      );
      assert.equal(prematureService.status, 2);
      assert.match(prematureService.stderr, /cannot activate before adoption/u);
      const disabledService = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          cli,
          "service",
          "install",
          "--config",
          authorityConfig,
          "--definition-dir",
          serviceDirectory,
        ],
        { encoding: "utf8" },
      );
      assert.equal(disabledService.status, 0, disabledService.stderr);
      assert.equal(JSON.parse(disabledService.stdout).activation, false);
      assert.equal(
        readFileSync(join(authorityRoot, "notes.txt"), "utf8"),
        "source notes\n",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

scenario(
  "durability",
  "adoption resumes without duplicate or unreferenced recovery at every durable boundary",
  async (context) => {
    const points: readonly AdoptionFaultPoint[] = [
      "after-apply-journal",
      "after-recovery-move",
      "after-local-conflict",
      "after-hub-conflict",
      "after-recovery-audit",
      "after-snapshot-apply",
      "after-hub-verification",
      "after-complete-marker",
    ];
    for (const point of points)
      await context.test(point, async () => {
        await withFleet(async (fleet) => {
          const sourceBefore = await verifyFullV3(fleet.authority);
          const plan = await planAdoptionV3(fleet.beta.config);
          let injected = false;
          await assert.rejects(
            applyAdoptionV3(fleet.beta.config, plan.adoptionId, {
              fault(candidate) {
                if (candidate !== point || injected) return;
                injected = true;
                throw new Error(`injected ${point}`);
              },
            }),
            new RegExp(`injected ${point}`, "u"),
          );
          assert.equal(injected, true);
          const resumed = await applyAdoptionV3(
            fleet.beta.config,
            plan.adoptionId,
          );
          assert.notEqual(
            resumed.status,
            "inconclusive",
            JSON.stringify(resumed),
          );
          assert.equal((await verifyFullV3(fleet.beta.config)).status, "clean");
          const conflicts = (
            await statusV3(fleet.beta.config)
          ).conflicts.filter(
            (conflict) => conflict.peerId === fleet.beta.config.peerId,
          );
          assert.equal(
            new Set(conflicts.map((conflict) => conflict.conflictId)).size,
            conflicts.length,
          );
          assert.ok(
            conflicts.every((conflict) => entryExists(conflict.recoveryPath)),
          );
          using state = new LocalState(fleet.beta.config);
          assert.equal(state.journals().length, 0);
          const sourceAfter = await verifyFullV3(fleet.authority);
          assert.equal(sourceAfter.hubSequence, sourceBefore.hubSequence);
        });
      });
  },
);

scenario(
  "durability",
  "source seal resumes through upload and acknowledgement failures",
  async (context) => {
    const points: readonly SealFaultPoint[] = [
      "after-outbox",
      "after-upload",
      "after-hub-accept",
      "after-outbox-ack",
    ];
    for (const point of points)
      await context.test(point, async () => {
        const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-seal-"));
        try {
          const root = join(base, "code");
          createSourceTree(root);
          const configPath = join(root, ".codefoldersync", "config.json");
          const { config } = await setupAuthorityV3({
            root,
            stateDir: join(base, "state"),
            folderName: "seal-resume",
            peerName: "authority",
            configPath,
            hub: { kind: "local", path: join(base, "hub") },
            backupWitness: "test-fixture",
          });
          await assert.rejects(
            sealSourceV3(config, {
              fault(candidate) {
                if (candidate === point) throw new Error(`injected ${point}`);
              },
            }),
            new RegExp(`injected ${point}`, "u"),
          );
          const resumed = await sealSourceV3(config);
          assert.equal(resumed.status, "clean", JSON.stringify(resumed));
          assert.equal((await verifyFullV3(config)).status, "clean");
          assert.equal(
            readFileSync(join(root, "notes.txt"), "utf8"),
            "source notes\n",
          );
          using state = new LocalState(config);
          assert.equal(state.outbox().length, 0);
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      });
  },
);

scenario(
  "durability",
  "cutover resumes after every durable boundary",
  async (context) => {
    const points: readonly CutoverFaultPoint[] = [
      "after-cutover-journal",
      "after-hub-cutover",
      "after-config-projection",
    ];
    for (const point of points)
      await context.test(point, async () => {
        await withFleet(async (fleet) => {
          for (const target of [fleet.beta, fleet.gamma]) {
            const plan = await planAdoptionV3(target.config);
            await applyAdoptionV3(target.config, plan.adoptionId);
          }
          await assert.rejects(
            cutoverAdoptionV3(fleet.authority, fleet.authorityConfigPath, {
              fault(candidate) {
                if (candidate === point) throw new Error(`injected ${point}`);
              },
            }),
            new RegExp(`injected ${point}`, "u"),
          );
          using interruptedState = new LocalState(fleet.authority);
          assert.equal(
            interruptedState
              .journals()
              .filter((journal) => journal.kind === "cutover").length,
            1,
          );
          const resumed = await cutoverAdoptionV3(
            fleet.authority,
            fleet.authorityConfigPath,
          );
          assert.equal(resumed.lifecycle, "normal");
          assert.equal(
            loadConfig(fleet.authorityConfigPath).lifecycle,
            "normal",
          );
          using resumedState = new LocalState(resumed);
          assert.equal(resumedState.journals().length, 0);
        });
      });
  },
);

scenario(
  "durability",
  "setup and configuration projection resume at every durable boundary",
  async (context) => {
    await context.test(
      "the hub peer opens its signed SSH hub path locally",
      async () => {
        const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-hub-peer-"));
        try {
          const authorityRoot = join(base, "authority", "Code");
          createSourceTree(authorityRoot);
          const hubPath = join(base, "hub-store");
          const authority = createAuthorityConfig({
            root: authorityRoot,
            stateDir: join(base, "authority", "state"),
            folderName: "hub-local-transport",
            peerName: "authority",
            hub: {
              kind: "ssh",
              host: "self-route-is-intentionally-absent.invalid",
              path: hubPath,
              command: [process.execPath],
            },
            backupWitness: "test-fixture",
          });
          const request = createPeerEnrollmentRequest({
            folderId: authority.folderId,
            root: join(base, "hub-peer", "Code"),
            stateDir: join(base, "hub-peer", "state"),
            peerName: "hub-peer",
            role: "hub",
          });
          const accepted = enrollPeer(authority, request);
          using hub = new HubStore(hubPath);
          hub.createFolder(accepted);
          const projected = activatePeerProjection(
            accepted,
            request,
            join(base, "hub-peer", "state"),
          );
          await using transport = await HubTransport.connectForPeer(projected);
          const checkpoint = await transport.checkpoint(projected.folderId);
          assert.equal(checkpoint.config.revision, accepted.revision);
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      },
    );
    const authorityPoints: readonly AuthoritySetupFaultPoint[] = [
      "after-authority-projection",
      "after-folder-creation",
    ];
    for (const point of authorityPoints)
      await context.test(point, async () => {
        const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-setup-"));
        try {
          const root = join(base, "code");
          createSourceTree(root);
          const input = {
            root,
            stateDir: join(base, "state"),
            folderName: "resumable-setup",
            peerName: "authority",
            configPath: join(root, ".codefoldersync", "config.json"),
            hub: { kind: "local" as const, path: join(base, "hub") },
            backupWitness: "test-fixture",
          };
          await assert.rejects(
            setupAuthorityV3(input, {
              fault(candidate) {
                if (candidate === point) throw new Error(`injected ${point}`);
              },
            }),
            new RegExp(`injected ${point}`, "u"),
          );
          const resumed = await setupAuthorityV3(input);
          using state = new LocalState(resumed.config);
          assert.equal(state.journals().length, 0);
          await using transport = await HubTransport.connect(
            resumed.config.hub,
          );
          assert.equal(
            (await transport.checkpoint(resumed.config.folderId)).config
              .revision,
            1,
          );
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      });

    const enrollmentPoints: readonly EnrollmentFaultPoint[] = [
      "after-peer-role-journal",
      "after-peer-role-accept",
      "after-authority-projection",
    ];
    const projectionPoints: readonly ProjectionFaultPoint[] = [
      "after-projection-journal",
      "after-ignore-projection",
      "after-config-projection",
    ];
    for (const index of enrollmentPoints.keys())
      await context.test(`enrollment and projection ${index}`, async () => {
        const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-role-"));
        try {
          const authorityRoot = join(base, "authority", "code");
          const targetRoot = join(base, "target", "code");
          createSourceTree(authorityRoot);
          createTargetTree(targetRoot, "beta");
          const authorityPath = join(
            authorityRoot,
            ".codefoldersync",
            "config.json",
          );
          const authority = (
            await setupAuthorityV3({
              root: authorityRoot,
              stateDir: join(base, "authority", "state"),
              folderName: "roles",
              peerName: "authority",
              configPath: authorityPath,
              hub: { kind: "local", path: join(base, "hub") },
              backupWitness: "test-fixture",
            })
          ).config;
          const request = preparePeerEnrollment({
            acceptedConfig: authority,
            root: targetRoot,
            stateDir: join(base, "target", "state"),
            peerName: "beta",
            requestPath: join(base, "target", "request.json"),
          });
          const enrollmentPoint = enrollmentPoints[index];
          assert.ok(enrollmentPoint);
          await assert.rejects(
            enrollPeerV3(
              {
                authorityConfig: authority,
                authorityConfigPath: authorityPath,
                request,
              },
              {
                fault(candidate) {
                  if (candidate === enrollmentPoint)
                    throw new Error(`injected ${enrollmentPoint}`);
                },
              },
            ),
            new RegExp(`injected ${enrollmentPoint}`, "u"),
          );
          const enrolled = await enrollPeerV3({
            authorityConfig: authority,
            authorityConfigPath: authorityPath,
            request,
          });
          const targetPath = join(targetRoot, ".codefoldersync", "config.json");
          const projectionPoint = projectionPoints[index];
          assert.ok(projectionPoint);
          assert.throws(
            () =>
              activatePeerV3(
                {
                  acceptedConfig: enrolled,
                  request,
                  stateDir: join(base, "target", "state"),
                  configPath: targetPath,
                },
                {
                  fault(candidate) {
                    if (candidate === projectionPoint)
                      throw new Error(`injected ${projectionPoint}`);
                  },
                },
              ),
            new RegExp(`injected ${projectionPoint}`, "u"),
          );
          const projected = activatePeerV3({
            acceptedConfig: enrolled,
            request,
            stateDir: join(base, "target", "state"),
            configPath: targetPath,
          });
          using authorityState = new LocalState(enrolled);
          using targetState = new LocalState(projected);
          assert.equal(authorityState.journals().length, 0);
          assert.equal(targetState.journals().length, 0);
          assert.equal(loadConfig(targetPath).revision, enrolled.revision);
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      });
  },
);

scenario(
  "adoption",
  "blocks target edits after planning and source edits after sealing",
  async () => {
    await withFleet(async (fleet) => {
      const stalePlan = await planAdoptionV3(fleet.beta.config);
      writeFileSync(
        join(fleet.beta.config.root, "notes.txt"),
        "late target edit\n",
      );
      await assert.rejects(
        applyAdoptionV3(fleet.beta.config, stalePlan.adoptionId),
        /Target changed after adoption planning/u,
      );
      assert.equal(
        readFileSync(join(fleet.beta.config.root, "notes.txt"), "utf8"),
        "late target edit\n",
      );

      const approvedPlan = await planAdoptionV3(fleet.beta.config);
      await applyAdoptionV3(fleet.beta.config, approvedPlan.adoptionId);
      const gammaPlan = await planAdoptionV3(fleet.gamma.config);
      await applyAdoptionV3(fleet.gamma.config, gammaPlan.adoptionId);

      writeFileSync(
        join(fleet.authority.root, "notes.txt"),
        "source edit after seal\n",
      );
      await assert.rejects(
        syncFolderV3(fleet.authority),
        /disabled until adoption cutover/u,
      );
      await assert.rejects(
        cutoverAdoptionV3(fleet.authority, fleet.authorityConfigPath),
        /Source changed after sealing/u,
      );
      assert.equal(
        readFileSync(join(fleet.authority.root, "notes.txt"), "utf8"),
        "source edit after seal\n",
      );
      assert.equal(
        readFileSync(join(fleet.beta.config.root, "notes.txt"), "utf8"),
        "source notes\n",
      );
    });
  },
);

scenario(
  "normal sync",
  "cuts over only after target verification and preserves concurrent normal writes",
  async () => {
    await withFleet(async (fleet) => {
      for (const target of [fleet.beta, fleet.gamma]) {
        const plan = await planAdoptionV3(target.config);
        await applyAdoptionV3(target.config, plan.adoptionId);
      }
      let authority = await cutoverAdoptionV3(
        fleet.authority,
        fleet.authorityConfigPath,
      );
      let beta = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.beta.request,
        stateDir: fleet.beta.stateDir,
        configPath: fleet.beta.configPath,
      });
      let gamma = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.gamma.request,
        stateDir: fleet.gamma.stateDir,
        configPath: fleet.gamma.configPath,
      });
      const betaIgnoredPath = join(beta.root, "clients", "app", "node_modules");
      assert.ok(existsSync(betaIgnoredPath));

      writeFileSync(join(authority.root, "shared.txt"), "authority edit\n");
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));
      assert.ok(existsSync(betaIgnoredPath));
      assertSynced(await syncFolderV3(gamma));
      assert.equal(
        readFileSync(join(beta.root, "shared.txt"), "utf8"),
        "authority edit\n",
      );

      writeFileSync(
        join(authority.root, "shared.txt"),
        "authority concurrent\n",
      );
      writeFileSync(join(beta.root, "shared.txt"), "beta concurrent\n");
      assertSynced(await syncFolderV3(authority));
      const conflicted = await syncFolderV3(beta);
      assert.ok(existsSync(betaIgnoredPath));
      assert.equal(conflicted.status, "conflict", JSON.stringify(conflicted));
      assert.equal((await syncFolderV3(authority)).status, "conflict");
      const conflictName = readdirSync(authority.root).find((name) =>
        name.includes("CODEFOLDERSYNC-CONFLICT"),
      );
      assert.ok(conflictName);
      assert.equal(
        readFileSync(join(authority.root, "shared.txt"), "utf8"),
        "authority concurrent\n",
      );
      assert.equal(
        readFileSync(join(authority.root, conflictName), "utf8"),
        "beta concurrent\n",
      );
      assert.ok(existsSync(join(beta.root, "clients", "app", "node_modules")));

      renameSync(join(gamma.root, "deep"), join(gamma.root, "renamed-deep"));
      const moved = await syncFolderV3(gamma);
      assert.equal(moved.uploadedObjects, 0, JSON.stringify(moved));
      await syncFolderV3(authority);
      await syncFolderV3(beta);
      assert.ok(existsSync(join(beta.root, "clients", "app", "node_modules")));
      assert.equal(
        readFileSync(join(authority.root, "renamed-deep", "child.txt"), "utf8"),
        "nested\n",
      );
      assert.equal(existsSync(join(authority.root, "deep")), false);

      writeFileSync(
        join(beta.root, "clients", "app", "node_modules", "local.txt"),
        "still ignored\n",
      );
      const ignored = await syncFolderV3(beta);
      assert.equal(ignored.published, false, JSON.stringify(ignored));

      writeFileSync(
        join(authority.root, "was-included.tmp"),
        "included first\n",
      );
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));
      assertSynced(await syncFolderV3(gamma));
      const nextIgnore = `${defaultIgnore}*.tmp\n`;
      writeFileSync(join(authority.root, ".codefoldersyncignore"), nextIgnore);
      const ignorePreview = await previewIgnoreRevisionV3(
        authority,
        defaultIgnore,
      );
      assert.notEqual(ignorePreview.previousDigest, ignorePreview.nextDigest);
      assert.ok(ignorePreview.newlyExcluded.count > 0);
      authority = await acceptIgnoreRevisionV3(
        authority,
        fleet.authorityConfigPath,
        defaultIgnore,
      );
      beta = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.beta.request,
        stateDir: fleet.beta.stateDir,
        configPath: fleet.beta.configPath,
        ignoreSource: nextIgnore,
      });
      gamma = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.gamma.request,
        stateDir: fleet.gamma.stateDir,
        configPath: fleet.gamma.configPath,
        ignoreSource: nextIgnore,
      });
      writeFileSync(join(beta.root, "ignored-after-revision.tmp"), "local\n");
      assert.equal((await syncFolderV3(beta)).published, false);

      writeFileSync(
        join(authority.root, ".codefoldersyncignore"),
        defaultIgnore,
      );
      const includePreview = await previewIgnoreRevisionV3(
        authority,
        nextIgnore,
      );
      assert.ok(includePreview.newlyIncluded.count > 0);
      authority = await acceptIgnoreRevisionV3(
        authority,
        fleet.authorityConfigPath,
        nextIgnore,
      );
      beta = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.beta.request,
        stateDir: fleet.beta.stateDir,
        configPath: fleet.beta.configPath,
        ignoreSource: defaultIgnore,
      });
      gamma = activatePeerV3({
        acceptedConfig: authority,
        request: fleet.gamma.request,
        stateDir: fleet.gamma.stateDir,
        configPath: fleet.gamma.configPath,
        ignoreSource: defaultIgnore,
      });
      assertSynced(await syncFolderV3(beta));
      assertSynced(await syncFolderV3(authority));
      assert.equal(
        readFileSync(
          join(authority.root, "ignored-after-revision.tmp"),
          "utf8",
        ),
        "local\n",
      );

      authority = loadConfig(fleet.authorityConfigPath);
      beta = loadConfig(fleet.beta.configPath);
      gamma = loadConfig(fleet.gamma.configPath);
      using betaState = new LocalState(beta);
      using betaObjects = new ObjectStore(join(beta.stateDir, "objects"));
      const unchanged = scanNamespace(
        beta,
        betaObjects,
        ensureIgnore(beta.root),
        betaState.catalog(),
      );
      assert.equal(unchanged.capturedFiles, 0);
      assert.ok(unchanged.reusedFiles > 0);
      assert.equal(authority.lifecycle, "normal");
      assert.equal(beta.lifecycle, "normal");
      assert.equal(gamma.lifecycle, "normal");
    });
  },
);

scenario(
  "normal sync",
  "composes a directory move with a concurrent descendant edit",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      renameSync(
        join(authority.root, "deep"),
        join(authority.root, "moved-deep"),
      );
      writeFileSync(
        join(beta.root, "deep", "child.txt"),
        "beta descendant edit\n",
      );
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));
      assertSynced(await syncFolderV3(authority));
      assert.equal(
        readFileSync(join(authority.root, "moved-deep", "child.txt"), "utf8"),
        "beta descendant edit\n",
      );
      assert.equal(existsSync(join(authority.root, "deep")), false);
    });
  },
);

scenario(
  "normal sync",
  "preserves a complete subtree for concurrent directory moves",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      renameSync(
        join(authority.root, "deep"),
        join(authority.root, "remote-deep"),
      );
      renameSync(join(beta.root, "deep"), join(beta.root, "beta-deep"));
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));
      assertSynced(await syncFolderV3(authority));
      assert.equal(
        readFileSync(join(authority.root, "remote-deep", "child.txt"), "utf8"),
        "nested\n",
      );
      const conflictDirectory = readdirSync(authority.root).find(
        (name) =>
          name.startsWith("beta-deep.CODEFOLDERSYNC-CONFLICT") &&
          existsSync(join(authority.root, name, "child.txt")),
      );
      assert.ok(conflictDirectory);
      assert.equal(
        readFileSync(
          join(authority.root, conflictDirectory, "child.txt"),
          "utf8",
        ),
        "nested\n",
      );
      assert.doesNotThrow(() =>
        git(join(authority.root, conflictDirectory, "nested-repo"), [
          "fsck",
          "--full",
        ]),
      );
      const conflict = (await statusV3(beta)).conflicts.find(
        (value) =>
          value.peerId === beta.peerId &&
          value.recoveryPath.startsWith("beta-deep.CODEFOLDERSYNC-CONFLICT"),
      );
      assert.ok(conflict?.manifestId);
      rmSync(join(beta.root, conflict.recoveryPath), {
        recursive: true,
        force: true,
      });
      const recovered = join(fleet.base, "recovered-directory-conflict");
      recoverConflictV3(beta, conflict.conflictId, recovered);
      assert.equal(
        readFileSync(join(recovered, "child.txt"), "utf8"),
        "nested\n",
      );
      assert.doesNotThrow(() =>
        git(join(recovered, "nested-repo"), ["fsck", "--full"]),
      );
    });
  },
);

scenario(
  "durability",
  "resumes normal apply after every durable phase",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      let movingPath = join(authority.root, "moving-apply");
      mkdirSync(movingPath);
      writeFileSync(join(movingPath, "child.txt"), "moving\n");
      let obsoletePath = join(authority.root, "obsolete-apply.txt");
      writeFileSync(obsoletePath, "obsolete\n");
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));

      const faultPoints: readonly NormalApplyFaultPoint[] = [
        "after-apply-journal",
        "after-moves-staged",
        "after-obsolete-recovery",
        "after-moves-placed",
        "after-directories",
        "after-leaves",
        "after-git",
      ];
      for (const [index, point] of faultPoints.entries()) {
        const nextMovingPath = join(authority.root, `moving-apply-${index}`);
        renameSync(movingPath, nextMovingPath);
        movingPath = nextMovingPath;
        rmSync(obsoletePath);
        obsoletePath = join(authority.root, `obsolete-apply-${index}.txt`);
        writeFileSync(obsoletePath, `obsolete ${index}\n`);
        const addedDirectory = join(authority.root, `apply-directory-${index}`);
        mkdirSync(addedDirectory);
        writeFileSync(join(addedDirectory, "leaf.txt"), `leaf ${index}\n`);
        writeFileSync(join(authority.root, "shared.txt"), `apply ${index}\n`);
        writeFileSync(
          join(authority.root, "clients", "app", "README.md"),
          `repository apply ${index}\n`,
        );
        git(join(authority.root, "clients", "app"), ["add", "."]);
        git(join(authority.root, "clients", "app"), [
          "commit",
          "-m",
          `apply ${index}`,
        ]);
        assertSynced(await syncFolderV3(authority));

        let injected = false;
        const interrupted = await syncFolderV3(beta, {
          fault(candidate) {
            if (!injected && candidate === point) {
              injected = true;
              throw new Error(`injected ${point}`);
            }
          },
        });
        assert.equal(injected, true);
        assert.equal(interrupted.status, "inconclusive");
        using interruptedState = new LocalState(beta);
        assert.equal(
          interruptedState
            .journals()
            .filter((journal) => journal.kind === "snapshot-apply").length,
          1,
        );

        if (index === 0) {
          const lateEdit = join(beta.root, "late-during-apply.txt");
          writeFileSync(lateEdit, "do not overwrite\n");
          const rejected = await syncFolderV3(beta);
          assert.equal(rejected.status, "inconclusive");
          assert.match(
            rejected.reasons.join("\n"),
            /changed during interrupted apply/u,
          );
          assert.equal(readFileSync(lateEdit, "utf8"), "do not overwrite\n");
          rmSync(lateEdit);
        }

        assertSynced(await syncFolderV3(beta));
        using resumedState = new LocalState(beta);
        assert.equal(resumedState.journals().length, 0);
        assert.equal(
          readFileSync(
            join(beta.root, `moving-apply-${index}`, "child.txt"),
            "utf8",
          ),
          "moving\n",
        );
        assert.equal(
          readFileSync(
            join(beta.root, `apply-directory-${index}`, "leaf.txt"),
            "utf8",
          ),
          `leaf ${index}\n`,
        );
        assert.equal(
          git(join(beta.root, "clients", "app"), ["rev-parse", "HEAD"]),
          git(join(authority.root, "clients", "app"), ["rev-parse", "HEAD"]),
        );
      }
    });
  },
);

scenario(
  "normal sync",
  "applies file and directory rename cycles without loss",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      writeFileSync(join(authority.root, "swap-a.txt"), "A\n");
      writeFileSync(join(authority.root, "swap-b.txt"), "B\n");
      writeFileSync(join(authority.root, "case-name.txt"), "case\n");
      writeFileSync(join(authority.root, "caf\u00e9.txt"), "unicode\n");
      mkdirSync(join(authority.root, "swap-dir-a"));
      mkdirSync(join(authority.root, "swap-dir-b"));
      writeFileSync(join(authority.root, "swap-dir-a", "value.txt"), "dir A\n");
      writeFileSync(join(authority.root, "swap-dir-b", "value.txt"), "dir B\n");
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));

      swapPaths(authority.root, "swap-a.txt", "swap-b.txt");
      swapPaths(authority.root, "swap-dir-a", "swap-dir-b");
      renameSync(
        join(authority.root, "case-name.txt"),
        join(authority.root, "Case-Name.txt"),
      );
      renameSync(
        join(authority.root, "caf\u00e9.txt"),
        join(authority.root, "cafe\u0301.txt"),
      );
      mkdirSync(join(authority.root, "open_source"));
      renameSync(
        join(authority.root, "clients", "app"),
        join(authority.root, "open_source", "app"),
      );
      const published = await syncFolderV3(authority);
      assertSynced(published);
      assert.equal(published.uploadedObjects, 0);
      assertSynced(await syncFolderV3(beta));
      assert.equal(readFileSync(join(beta.root, "swap-a.txt"), "utf8"), "B\n");
      assert.equal(readFileSync(join(beta.root, "swap-b.txt"), "utf8"), "A\n");
      assert.equal(
        readFileSync(join(beta.root, "swap-dir-a", "value.txt"), "utf8"),
        "dir B\n",
      );
      assert.equal(
        readFileSync(join(beta.root, "swap-dir-b", "value.txt"), "utf8"),
        "dir A\n",
      );
      assert.equal(
        readFileSync(join(beta.root, "Case-Name.txt"), "utf8"),
        "case\n",
      );
      assert.equal(
        readFileSync(join(beta.root, "cafe\u0301.txt"), "utf8"),
        "unicode\n",
      );
      assert.equal(existsSync(join(beta.root, "case-name.txt")), false);
      assert.equal(existsSync(join(beta.root, "caf\u00e9.txt")), false);
      assert.equal(
        readFileSync(
          join(beta.root, "open_source", "app", "node_modules", "local.txt"),
          "utf8",
        ),
        "beta ignored dependency\n",
      );
      assert.doesNotThrow(() =>
        git(join(beta.root, "open_source", "app"), ["fsck", "--full"]),
      );
    });
  },
);

scenario(
  "integrity",
  "rejects corrupt hub objects before mutating the target",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      const hubObjectsPath = join(fleet.base, "hub", "objects");
      let before: ReadonlySet<string>;
      {
        using hubObjects = new ObjectStore(hubObjectsPath);
        before = new Set(hubObjects.listIds());
      }
      writeFileSync(
        join(authority.root, "corruption-canary.txt"),
        "uncorrupted\n",
      );
      assertSynced(await syncFolderV3(authority));
      let newObjectIds: readonly string[];
      {
        using hubObjects = new ObjectStore(hubObjectsPath);
        newObjectIds = hubObjects.listIds().filter((id) => !before.has(id));
      }
      assert.ok(newObjectIds.length > 0);
      const corruptedId = newObjectIds[0];
      assert.ok(corruptedId);
      using database = new DatabaseSync(join(hubObjectsPath, "objects.sqlite"));
      database
        .prepare("UPDATE objects SET bytes=? WHERE id=?")
        .run(Buffer.from("deliberately corrupt"), corruptedId);

      const rejected = await syncFolderV3(beta);
      assert.equal(rejected.status, "inconclusive");
      assert.match(rejected.reasons.join("\n"), /Corrupt object/u);
      assert.equal(existsSync(join(beta.root, "corruption-canary.txt")), false);
    });
  },
);

scenario(
  "normal sync",
  "synchronizes a contained Git indirection",
  async () => {
    await withFleet(async (fleet) => {
      const { authority, beta } = await adoptAndCutover(fleet);
      const worktree = join(authority.root, "contained-worktree");
      const gitDirectory = join(authority.root, "contained-metadata.git");
      git(authority.root, [
        "init",
        "--separate-git-dir",
        gitDirectory,
        worktree,
      ]);
      writeFileSync(join(worktree, "README.md"), "contained metadata\n");
      git(worktree, ["add", "."]);
      git(worktree, ["commit", "-m", "contained indirection"]);
      assertSynced(await syncFolderV3(authority));
      assertSynced(await syncFolderV3(beta));
      assert.match(
        readFileSync(join(beta.root, "contained-worktree", ".git"), "utf8"),
        /^gitdir: \.\.\/contained-metadata\.git\n$/u,
      );
      assert.equal(
        git(join(beta.root, "contained-worktree"), ["rev-parse", "HEAD"]),
        git(worktree, ["rev-parse", "HEAD"]),
      );
      assert.doesNotThrow(() =>
        git(join(beta.root, "contained-worktree"), ["fsck", "--full"]),
      );
      await using transport = await HubTransport.connect(authority.hub);
      const mutations = (await transport.history(authority.folderId)).flatMap(
        (event) =>
          typeof event.mutations_json === "string"
            ? (JSON.parse(event.mutations_json) as {
                readonly kind?: unknown;
                readonly objectIds?: unknown;
              }[])
            : [],
      );
      assert.ok(
        mutations.some(
          (mutation) =>
            mutation.kind === "git-state" &&
            Array.isArray(mutation.objectIds) &&
            mutation.objectIds.length > 0,
        ),
      );
    });
  },
);

scenario(
  "conflicts",
  "preserves delete/edit and file/directory conflicts",
  async (context) => {
    await context.test("accepted delete against local edit", async () => {
      await withFleet(async (fleet) => {
        const { authority, beta } = await adoptAndCutover(fleet);
        rmSync(join(authority.root, "shared.txt"));
        writeFileSync(join(beta.root, "shared.txt"), "beta survives delete\n");
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        assertSynced(await syncFolderV3(authority));
        assert.equal(existsSync(join(authority.root, "shared.txt")), false);
        const conflict = readdirSync(authority.root).find((name) =>
          name.startsWith("shared.CODEFOLDERSYNC-CONFLICT"),
        );
        assert.ok(conflict);
        assert.equal(
          readFileSync(join(authority.root, conflict), "utf8"),
          "beta survives delete\n",
        );
      });
    });

    await context.test("accepted edit against local delete", async () => {
      await withFleet(async (fleet) => {
        const { authority, beta } = await adoptAndCutover(fleet);
        writeFileSync(
          join(authority.root, "shared.txt"),
          "authority survives\n",
        );
        rmSync(join(beta.root, "shared.txt"));
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        assertSynced(await syncFolderV3(authority));
        assert.equal(
          readFileSync(join(authority.root, "shared.txt"), "utf8"),
          "authority survives\n",
        );
        assert.ok(
          (await statusV3(beta)).conflicts.some((conflict) =>
            conflict.reason.includes("delete conflicted"),
          ),
        );
      });
    });

    await context.test("concurrent file and directory creation", async () => {
      await withFleet(async (fleet) => {
        const { authority, beta } = await adoptAndCutover(fleet);
        mkdirSync(join(authority.root, "new-kind"));
        writeFileSync(
          join(authority.root, "new-kind", "child.txt"),
          "remote\n",
        );
        writeFileSync(join(beta.root, "new-kind"), "local file\n");
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        assertSynced(await syncFolderV3(authority));
        assert.equal(
          readFileSync(join(authority.root, "new-kind", "child.txt"), "utf8"),
          "remote\n",
        );
        const conflict = readdirSync(authority.root).find((name) =>
          name.startsWith("new-kind.CODEFOLDERSYNC-CONFLICT"),
        );
        assert.ok(conflict);
        assert.equal(
          readFileSync(join(authority.root, conflict), "utf8"),
          "local file\n",
        );
      });
    });

    await context.test("accepted move against local delete", async () => {
      await withFleet(async (fleet) => {
        const { authority, beta } = await adoptAndCutover(fleet);
        renameSync(
          join(authority.root, "shared.txt"),
          join(authority.root, "moved-shared.txt"),
        );
        rmSync(join(beta.root, "shared.txt"));
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        assertSynced(await syncFolderV3(authority));
        assert.equal(
          readFileSync(join(authority.root, "moved-shared.txt"), "utf8"),
          "baseline\n",
        );
        assert.ok(
          (await statusV3(beta)).conflicts.some((conflict) =>
            conflict.reason.includes("delete conflicted"),
          ),
        );
      });
    });

    await context.test("delete followed by restore", async () => {
      await withFleet(async (fleet) => {
        const { authority, beta } = await adoptAndCutover(fleet);
        rmSync(join(authority.root, "shared.txt"));
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        writeFileSync(join(authority.root, "shared.txt"), "baseline\n");
        assertSynced(await syncFolderV3(authority));
        assertSynced(await syncFolderV3(beta));
        assert.equal(
          readFileSync(join(beta.root, "shared.txt"), "utf8"),
          "baseline\n",
        );
        using state = new LocalState(beta);
        const history = state.catalogHistory();
        assert.ok(
          history.some(
            (entry) => entry.tombstone && entry.entry.path === "shared.txt",
          ),
        );
        assert.ok(
          history.every(
            (entry) =>
              entry.entryVersion.length === 64 &&
              entry.contentVersion.length === 64,
          ),
        );
        await using transport = await HubTransport.connect(authority.hub);
        const mutations = (await transport.history(authority.folderId)).flatMap(
          (event) => {
            if (typeof event.mutations_json !== "string") return [];
            return JSON.parse(event.mutations_json) as {
              readonly kind?: unknown;
              readonly nodeId?: unknown;
            }[];
          },
        );
        assert.ok(
          mutations.some((mutation) => mutation.kind === "restore-entry"),
        );
      });
    });
  },
);

scenario(
  "integrity",
  "rejects target config tampering, external Git dirs, and premature cutover",
  async () => {
    await withFleet(async (fleet) => {
      await assert.rejects(
        cutoverAdoptionV3(fleet.authority, fleet.authorityConfigPath),
        /not verified/u,
      );

      await using transport = await HubTransport.connect(fleet.authority.hub);
      const checkpoint = await transport.checkpoint(fleet.authority.folderId);
      assert.ok(checkpoint.snapshot);
      const forgedVerification: SignedAdoptionVerification = {
        folderId: fleet.authority.folderId,
        peerId: fleet.beta.config.peerId,
        eventId: randomUUID(),
        sourceSequence: checkpoint.sequence,
        sourceDigest: checkpoint.snapshot.digest,
        signature: "",
      };
      await assert.rejects(
        transport.recordAdoptionVerification({
          ...forgedVerification,
          signature: signPayload(
            adoptionVerificationPayload(forgedVerification),
            peerPrivateKey(fleet.authority),
          ),
        }),
        /signature/u,
      );
      const forgedConflict: SignedConflict = {
        folderId: fleet.authority.folderId,
        peerId: fleet.beta.config.peerId,
        eventId: randomUUID(),
        conflict: {
          conflictId: randomUUID(),
          kind: "adoption",
          peerId: fleet.beta.config.peerId,
          originalPath: "sha256:forged",
          recoveryPath: "local-only",
          manifestId: null,
          reason: "forged",
          createdAt: new Date().toISOString(),
        },
        signature: "",
      };
      await assert.rejects(
        transport.addConflict({
          ...forgedConflict,
          signature: signPayload(
            conflictPayload(forgedConflict),
            peerPrivateKey(fleet.authority),
          ),
        }),
        /signature/u,
      );
      assert.deepEqual(
        await transport.verifiedAdoptionPeers(fleet.authority.folderId),
        [],
      );

      const tamperedPath = join(fleet.base, "tampered.json");
      const tampered = {
        ...fleet.beta.config,
        lifecycle: "normal",
      };
      writeFileSync(tamperedPath, JSON.stringify(tampered));
      assert.throws(() => loadConfig(tamperedPath), /signature/u);
      const targetIgnorePath = join(
        fleet.beta.config.root,
        ".codefoldersyncignore",
      );
      const acceptedIgnore = readFileSync(targetIgnorePath, "utf8");
      writeFileSync(targetIgnorePath, `${acceptedIgnore}!target-only.txt\n`);
      await assert.rejects(
        planAdoptionV3(fleet.beta.config),
        /does not match the accepted configuration/u,
      );
      writeFileSync(targetIgnorePath, acceptedIgnore);

      const unsafeBase = join(fleet.base, "unsafe");
      const unsafeRoot = join(unsafeBase, "code");
      const external = join(unsafeBase, "external.git");
      mkdirSync(join(unsafeRoot, "linked"), { recursive: true });
      gitBare(external);
      writeFileSync(
        join(unsafeRoot, "linked", ".git"),
        `gitdir: ${external}\n`,
      );
      const setup = await setupAuthorityV3({
        root: unsafeRoot,
        stateDir: join(unsafeBase, "state"),
        folderName: "unsafe",
        peerName: "authority",
        configPath: join(unsafeBase, "config.json"),
        hub: { kind: "local", path: join(unsafeBase, "hub") },
        backupWitness: "test-fixture",
      });
      await assert.rejects(
        sealSourceV3(setup.config),
        /External Git directory/u,
      );
    });
  },
);

scenario(
  "integrity",
  "fails closed on portable aliases and unsupported filesystem objects",
  async (context) => {
    await context.test("case aliases", () => {
      withScanFixture((root, config, objects) => {
        writeFileSync(join(root, "Case.txt"), "upper\n");
        writeFileSync(join(root, "case.txt"), "lower\n");
        assert.throws(
          () => scanNamespace(config, objects, ensureIgnore(root), [], true),
          /Portable name collision/u,
        );
      });
    });

    await context.test("Unicode normalization aliases", () => {
      withScanFixture((root, config, objects) => {
        writeFileSync(join(root, "é.txt"), "composed\n");
        writeFileSync(join(root, "e\u0301.txt"), "decomposed\n");
        assert.throws(
          () => scanNamespace(config, objects, ensureIgnore(root), [], true),
          /Portable name collision/u,
        );
      });
    });
    await context.test("FIFO", () => {
      withScanFixture((root, config, objects) => {
        const fifo = spawnSync("mkfifo", [join(root, "unsafe.fifo")], {
          encoding: "utf8",
        });
        assert.equal(fifo.status, 0, fifo.stderr);
        assert.throws(
          () => scanNamespace(config, objects, ensureIgnore(root), [], true),
          /Unsupported filesystem object/u,
        );
      });
    });

    await context.test("Unix socket", async () => {
      const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-socket-"));
      const root = join(base, "code");
      const stateDir = join(base, "state");
      mkdirSync(root, { recursive: true });
      const config = createAuthorityConfig({
        root,
        stateDir,
        folderName: "socket",
        peerName: "authority",
        hub: { kind: "local", path: join(base, "hub") },
        backupWitness: "test-fixture",
      });
      using objects = new ObjectStore(join(stateDir, "objects"));
      const socketPath = join(root, "unsafe.socket");
      const server = createServer();
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(socketPath, resolveListen);
        });
        assert.throws(
          () => scanNamespace(config, objects, ensureIgnore(root), [], true),
          /Unsupported filesystem object/u,
        );
      } finally {
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

scenario(
  "protocol",
  "ignore compilation and framed process transport use production contracts",
  async () => {
    const ignore = compileIgnore(`
*.log
!important.log
/build/
foo/**/bar?.txt
`);
    assert.equal(ignore.ignores("debug.log", false), true);
    assert.equal(ignore.ignores("nested/debug.log", false), true);
    assert.equal(ignore.ignores("important.log", false), false);
    assert.equal(ignore.ignores("build", true), true);
    assert.equal(ignore.ignores("nested/build", true), false);
    assert.equal(ignore.ignores("foo/a/b/bar1.txt", false), true);
    assert.equal(ignore.ignores(".workspace-sync/state.json", false), true);

    const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-framed-"));
    try {
      const hub = join(base, "hub");
      const root = join(base, "code");
      const stateDir = join(base, "state");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "framed.txt"), "frame payload\n");
      const config = createAuthorityConfig({
        root,
        stateDir,
        folderName: "framed",
        peerName: "authority",
        hub: { kind: "local", path: hub },
        backupWitness: "test-fixture",
      });
      using objects = new ObjectStore(join(stateDir, "objects"));
      const scanned = scanNamespace(
        config,
        objects,
        ensureIgnore(config.root),
        [],
        true,
      );
      const encoded = Buffer.from(hub, "utf8").toString("base64url");
      await using transport = await HubTransport.connectProcess(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "src", "product-cli.ts"),
          "hub",
          "serve",
          "--stdio",
          "--hub-base64",
          encoded,
        ],
      );
      await transport.createFolder(config);
      const objectIds = manifestObjectIds(scanned.manifest, objects);
      assert.ok((await transport.ensureHubObjects(objectIds, objects)) > 0);
      const publishedConflict: ConflictRecord = {
        conflictId: randomUUID(),
        kind: "normal",
        peerId: config.peerId,
        originalPath: "deep/file.txt",
        recoveryPath: "deep/file (conflict).txt",
        manifestId: null,
        reason: "transport atomicity fixture",
        createdAt: new Date().toISOString(),
      };
      const sealedUnsigned: SignedSnapshot = {
        snapshot: scanned.manifest,
        peerId: config.peerId,
        baseSequence: 0,
        eventId: randomUUID(),
        peerSequence: 1,
        mutations: [],
        conflicts: [],
        signature: "",
      };
      const sealedWithMutations: SignedSnapshot = {
        ...sealedUnsigned,
        mutations: deriveMutations({
          config,
          eventId: sealedUnsigned.eventId,
          peerSequence: sealedUnsigned.peerSequence,
          base: null,
          next: scanned.manifest,
          objects,
        }),
      };
      const sealed: SignedSnapshot = {
        ...sealedWithMutations,
        signature: signPayload(
          snapshotPayload(sealedWithMutations),
          peerPrivateKey(config),
        ),
      };
      await transport.acceptSnapshot(sealed);
      const normalConfig = reviseConfig(
        config,
        { lifecycle: "normal" },
        authorityPrivateKey(config),
      );
      await transport.updateConfig(normalConfig, config.revision);
      const checkpoint = await transport.checkpoint(config.folderId);
      const unsigned: SignedSnapshot = {
        snapshot: scanned.manifest,
        peerId: config.peerId,
        baseSequence: checkpoint.sequence,
        eventId: randomUUID(),
        peerSequence: 2,
        mutations: [],
        conflicts: [publishedConflict],
        signature: "",
      };
      const signed: SignedSnapshot = {
        ...unsigned,
        signature: signPayload(
          snapshotPayload(unsigned),
          peerPrivateKey(config),
        ),
      };
      const sequence = await transport.acceptSnapshot(signed);
      assert.equal(await transport.acceptSnapshot(signed), sequence);
      assert.deepEqual(await transport.conflicts(config.folderId), [
        publishedConflict,
      ]);
      const acceptedEvents = (await transport.history(config.folderId)).filter(
        (event) => event.peer_sequence !== null,
      );
      assert.deepEqual(
        acceptedEvents.map((event) => Number(event.peer_sequence)),
        [1, 2],
      );
      const sealedMutations = JSON.parse(
        String(acceptedEvents[0]?.mutations_json),
      ) as {
        readonly kind?: unknown;
        readonly eventId?: unknown;
        readonly peerSequence?: unknown;
        readonly baseConfigRevision?: unknown;
      }[];
      assert.ok(
        sealedMutations.some((mutation) => mutation.kind === "put-node"),
      );
      assert.ok(
        sealedMutations.every(
          (mutation) =>
            typeof mutation.eventId === "string" &&
            mutation.peerSequence === 1 &&
            mutation.baseConfigRevision === config.revision,
        ),
      );
      assert.deepEqual(
        JSON.parse(String(acceptedEvents[1]?.mutations_json)),
        [],
      );
      assert.equal(
        (await transport.checkpoint(config.folderId)).snapshot?.digest,
        scanned.manifest.digest,
      );
      using downloaded = new ObjectStore(join(base, "downloaded"));
      assert.equal(
        await transport.fetchObjects(objectIds, downloaded),
        objectIds.length,
      );
      const alteredUnsigned: SignedSnapshot = {
        ...unsigned,
        snapshot: {
          ...scanned.manifest,
          createdAt: "2099-01-01T00:00:00.000Z",
        },
      };
      const altered: SignedSnapshot = {
        ...alteredUnsigned,
        signature: signPayload(
          snapshotPayload(alteredUnsigned),
          peerPrivateKey(config),
        ),
      };
      await assert.rejects(
        transport.acceptSnapshot(altered),
        /reused with a different payload/u,
      );
      const malformedEventId = randomUUID();
      const malformedUnsigned: SignedSnapshot = {
        ...unsigned,
        baseSequence: sequence,
        eventId: malformedEventId,
        peerSequence: 3,
        mutations: sealed.mutations.slice(0, 1).map((mutation) => ({
          ...mutation,
          eventId: `${malformedEventId}:mutation:0`,
          peerSequence: 3,
        })),
        signature: "",
      };
      await assert.rejects(
        transport.acceptSnapshot({
          ...malformedUnsigned,
          signature: signPayload(
            snapshotPayload(malformedUnsigned),
            peerPrivateKey(config),
          ),
        }),
        /mutation list/u,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

const scenarioContext: ScenarioContext = {
  async test(name, action) {
    try {
      await action();
    } catch (error) {
      throw new Error(name, { cause: error });
    }
  },
};

for (const group of new Set(scenarios.map((value) => value.group)))
  nodeTest(`V3 ${group}`, async () => {
    for (const item of scenarios.filter((value) => value.group === group))
      try {
        await item.action(scenarioContext);
      } catch (error) {
        throw new Error(item.name, { cause: error });
      }
  });

interface TargetPeer {
  readonly name: "beta" | "gamma";
  readonly config: ProductConfig;
  readonly configPath: string;
  readonly stateDir: string;
  readonly request: PeerEnrollmentRequest;
}

interface Fleet {
  readonly base: string;
  readonly authority: ProductConfig;
  readonly authorityConfigPath: string;
  readonly beta: TargetPeer;
  readonly gamma: TargetPeer;
}

async function withFleet(
  action: (fleet: Fleet) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-product-"));
  try {
    const authorityRoot = join(base, "authority", "code");
    createSourceTree(authorityRoot);
    const authorityConfigPath = join(
      authorityRoot,
      ".codefoldersync",
      "config.json",
    );
    let authority = (
      await setupAuthorityV3({
        root: authorityRoot,
        stateDir: join(base, "authority", "state"),
        folderName: "integration",
        peerName: "authority",
        configPath: authorityConfigPath,
        hub: { kind: "local", path: join(base, "hub") },
        backupWitness: "test-fixture",
      })
    ).config;

    const betaPrepared = prepareTarget(base, authority, "beta");
    authority = await enrollPeerV3({
      authorityConfig: authority,
      authorityConfigPath,
      request: betaPrepared.request,
    });
    const gammaPrepared = prepareTarget(base, authority, "gamma");
    authority = await enrollPeerV3({
      authorityConfig: authority,
      authorityConfigPath,
      request: gammaPrepared.request,
    });
    const beta: TargetPeer = {
      ...betaPrepared,
      config: activatePeerV3({
        acceptedConfig: authority,
        request: betaPrepared.request,
        stateDir: betaPrepared.stateDir,
        configPath: betaPrepared.configPath,
      }),
    };
    const gamma: TargetPeer = {
      ...gammaPrepared,
      config: activatePeerV3({
        acceptedConfig: authority,
        request: gammaPrepared.request,
        stateDir: gammaPrepared.stateDir,
        configPath: gammaPrepared.configPath,
      }),
    };
    const sealed = await sealSourceV3(authority);
    assert.equal(sealed.status, "clean", JSON.stringify(sealed));
    await action({ base, authority, authorityConfigPath, beta, gamma });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function adoptAndCutover(fleet: Fleet): Promise<{
  readonly authority: ProductConfig;
  readonly beta: ProductConfig;
  readonly gamma: ProductConfig;
}> {
  for (const target of [fleet.beta, fleet.gamma]) {
    const plan = await planAdoptionV3(target.config);
    await applyAdoptionV3(target.config, plan.adoptionId);
  }
  const authority = await cutoverAdoptionV3(
    fleet.authority,
    fleet.authorityConfigPath,
  );
  const beta = activatePeerV3({
    acceptedConfig: authority,
    request: fleet.beta.request,
    stateDir: fleet.beta.stateDir,
    configPath: fleet.beta.configPath,
  });
  const gamma = activatePeerV3({
    acceptedConfig: authority,
    request: fleet.gamma.request,
    stateDir: fleet.gamma.stateDir,
    configPath: fleet.gamma.configPath,
  });
  return { authority, beta, gamma };
}

function prepareTarget(
  base: string,
  accepted: ProductConfig,
  name: "beta" | "gamma",
): Omit<TargetPeer, "config"> {
  const root = join(base, name, "code");
  createTargetTree(root, name);
  const stateDir = join(base, name, "state");
  const configPath = join(root, ".codefoldersync", "config.json");
  const request = preparePeerEnrollment({
    acceptedConfig: accepted,
    root,
    stateDir,
    peerName: name,
    requestPath: join(base, name, "request.json"),
  });
  return { name, stateDir, configPath, request };
}

function createSourceTree(root: string): void {
  mkdirSync(join(root, "deep"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "source notes\n");
  writeFileSync(join(root, "canonical.txt"), "same bytes at another path\n");
  writeFileSync(join(root, "shared.txt"), "baseline\n");
  writeFileSync(join(root, "deep", "child.txt"), "nested\n");
  mkdirSync(join(root, "empty-directory"));
  writeFileSync(join(root, "kind-swap"), "source file\n");
  writeFileSync(join(root, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  symlinkSync("missing-target", join(root, "broken-link"));
  symlinkSync("/definitely/missing", join(root, "absolute-link"));
  createRepository(join(root, "deep", "nested-repo"), "nested repository\n");
  createRepository(join(root, "clients", "app"), "source repository\n");
}

function createTargetTree(root: string, name: "beta" | "gamma"): void {
  mkdirSync(join(root, "deep"), { recursive: true });
  mkdirSync(join(root, ".workspace-sync"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), `${name} divergent notes\n`);
  writeFileSync(join(root, "moved-target.txt"), "same bytes at another path\n");
  writeFileSync(join(root, "target-only.txt"), `${name} only\n`);
  writeFileSync(join(root, "shared.txt"), "baseline\n");
  writeFileSync(join(root, "deep", "child.txt"), "nested\n");
  mkdirSync(join(root, "kind-swap"));
  writeFileSync(
    join(root, "kind-swap", "target.txt"),
    `${name} type conflict\n`,
  );
  writeFileSync(join(root, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  symlinkSync(`${name}-target`, join(root, "broken-link"));
  mkdirSync(join(root, "target-tree", "child"), { recursive: true });
  writeFileSync(
    join(root, "target-tree", "child", "target.txt"),
    `${name} subtree\n`,
  );
  writeFileSync(
    join(root, ".workspace-sync", "state.json"),
    `${name} local control\n`,
  );
  createRepository(join(root, "clients", "app"), `${name} repository\n`);
  mkdirSync(join(root, "clients", "app", "node_modules"), { recursive: true });
  writeFileSync(
    join(root, "clients", "app", "node_modules", "local.txt"),
    `${name} ignored dependency\n`,
  );
}

function createRepository(path: string, content: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init"]);
  writeFileSync(join(path, "README.md"), content);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture"]);
}

function swapPaths(root: string, left: string, right: string): void {
  const temporary = join(root, `${left}.swap-temporary`);
  renameSync(join(root, left), temporary);
  renameSync(join(root, right), join(root, left));
  renameSync(temporary, join(root, right));
}

function gitBare(path: string): void {
  const result = spawnSync("git", ["init", "--bare", path], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
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

function assertSynced(result: Awaited<ReturnType<typeof syncFolderV3>>): void {
  assert.notEqual(result.status, "offline", JSON.stringify(result));
  assert.notEqual(result.status, "inconclusive", JSON.stringify(result));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function withScanFixture(
  action: (root: string, config: ProductConfig, objects: ObjectStore) => void,
): void {
  const base = mkdtempSync(join(tmpdir(), "codefoldersync-v3-scan-"));
  try {
    const root = join(base, "code");
    const stateDir = join(base, "state");
    mkdirSync(root, { recursive: true });
    const config = createAuthorityConfig({
      root,
      stateDir,
      folderName: "scan",
      peerName: "authority",
      hub: { kind: "local", path: join(base, "hub") },
      backupWitness: "test-fixture",
    });
    using objects = new ObjectStore(join(stateDir, "objects"));
    action(root, config, objects);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
