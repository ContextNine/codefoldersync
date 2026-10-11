import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const probeDirectory = "codefoldersync-full-folder-stress";
let phase = "preflight";
const physical = (path) => {
  assert.ok(isAbsolute(path) && resolve(path) === path);
  assert.equal(realpathSync(path), path);
  return path;
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (path) => {
  const digest = createHash("sha256");
  for await (const part of createReadStream(path)) digest.update(part);
  return digest.digest("hex");
};
const command = (program, args, env, input) => {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 1024 ** 2,
  });
  assert.equal(result.status, 0, "Disposable stress command failed");
  return result.stdout;
};

/** Complete protected folders remain present in every independently writable peer. */
export async function runFullFolderStress(spec) {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_OPTIONAL_LOCKS = "0";
  assert.equal(spec.schemaVersion, 1);
  assert.ok(["default-branch", "plaintext-env"].includes(spec.caseId));
  assert.ok(
    typeof spec.sourceRelativePath === "string" &&
      spec.sourceRelativePath.length > 0 &&
      !isAbsolute(spec.sourceRelativePath) &&
      !spec.sourceRelativePath.includes("\\") &&
      !spec.sourceRelativePath.includes("\0") &&
      spec.sourceRelativePath
        .split("/")
        .every((part) => part && part !== "." && part !== ".."),
  );
  assert.ok(
    ["complete-original-folder", "public-fixture"].includes(spec.corpus),
  );
  assert.match(spec.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    await fileHash(physical(spec.candidateArchive)),
    spec.candidateSha256,
  );
  const packageRoot = physical(spec.packageRoot);
  const module = (name) =>
    import(pathToFileURL(join(packageRoot, "dist/v3", `${name}.js`)).href);
  const [
    { createTreeWitness, makeTreeOwnerWritable },
    { validateBoundedReflinkStorage },
    storage,
    distributed,
    processExecutor,
    { loadConfig },
    { readEnrollmentRequest },
    policy,
    ignoreModule,
  ] = await Promise.all([
    module("acceptance"),
    module("acceptance-reflink"),
    module("storage"),
    module("distributed"),
    module("distributed-process"),
    module("config"),
    module("setup"),
    module("policy"),
    module("ignore"),
  ]);
  const run = { schemaVersion: 1, runId: spec.runId, runRoot: spec.runRoot };
  const root = physical(storage.validateCleanupRunRoot(run));
  const master = physical(spec.masterRoot);
  assert.ok(master.startsWith(`${physical(spec.storage.mountRoot)}${sep}`));
  assert.ok(packageRoot.startsWith(`${spec.storage.mountRoot}${sep}`));
  assert.ok((lstatSync(master).mode & 0o222) === 0);
  assert.equal(spec.repetitions, 2);
  assert.ok(
    Number.isInteger(spec.rounds) &&
      spec.rounds >= (spec.corpus === "public-fixture" ? 2 : 24) &&
      spec.rounds <= 128,
  );
  assert.ok(
    Number.isSafeInteger(spec.uid) &&
      process.getuid() === spec.uid &&
      spec.uid > 0,
  );
  physical(spec.command[0]);
  assert.ok(spec.command[0].startsWith(`${spec.storage.mountRoot}${sep}`));
  if (spec.corpus === "complete-original-folder") {
    const receipt = JSON.parse(
      readFileSync(physical(spec.originalAcceptanceReceipt), "utf8"),
    );
    assert.equal(receipt.passed, true);
    assert.equal(receipt.acceptanceCorpus, true);
    assert.equal(receipt.candidateSha256, spec.candidateSha256);
    assert.equal(
      spec.originalSnapshotId,
      "codefoldersync-backup-20260825T102132Z",
    );
    assert.equal(spec.originalMachineId, "wootbook");
    const parent = receipt.historicalTrees.find(
      (entry) => entry.machineId === spec.originalMachineId,
    );
    assert.ok(parent);
    const parentRoot = physical(spec.originalMasterRoot);
    assert.ok(parentRoot.startsWith(`${spec.storage.mountRoot}${sep}`));
    assert.equal(lstatSync(parentRoot).mode & 0o222, 0);
    assert.equal(master, join(parentRoot, spec.sourceRelativePath));
    assert.deepEqual(await createTreeWitness(parentRoot), parent.witness);
  }
  const defaultBranchOnly = spec.caseId === "default-branch";
  // Only generated canary ENV values are transferable; archived ENV stays local.
  const syncPolicy = defaultBranchOnly
    ? { mode: "default-branch", branch: spec.defaultBranch }
    : {
        mode: "selected-files",
        includes: [probeDirectory, `${probeDirectory}-moved`].flatMap(
          (directory) => [`${directory}/**/.env`, `${directory}/**/.env.*`],
        ),
        plaintextEnv: true,
      };
  policy.validateSyncPolicy(syncPolicy);
  const beforeMaster = await createTreeWitness(master);
  assert.deepEqual(beforeMaster, spec.masterWitness);
  storage.validateCleanupRunRoot(run);
  validateBoundedReflinkStorage(spec.storage, [root, master]);
  processExecutor.validateNativeFaultLibrary(spec.nativeFaultLibrary);
  assert.equal(existsSync(spec.evidenceDirectory), false);
  physical(dirname(spec.evidenceDirectory));
  const results = [];
  try {
    for (let repetition = 1; repetition <= 2; repetition++) {
      phase = `repetition-${repetition}`;
      const repetitionRoot = join(root, `run-${spec.caseId}-${repetition}`);
      mkdirSync(repetitionRoot, { mode: 0o700 });
      const childRun = {
        schemaVersion: 1,
        runId: `${spec.runId}-${repetition}`,
        runRoot: repetitionRoot,
      };
      writeFileSync(join(repetitionRoot, "SENTINEL"), `${childRun.runId}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const peers = [];
      const beforeOutside = new Map();
      const expectedGit = new Map();
      const gitRoots = new Map();
      for (const name of ["source", "second", "third"]) {
        const peer = {
          machineId: name,
          peerName: name,
          endpoint: { kind: "local" },
          root: join(repetitionRoot, name, "workspace"),
          stateDir: join(repetitionRoot, name, "state"),
          configPath: join(
            repetitionRoot,
            name,
            "workspace/.codefoldersync/config.json",
          ),
        };
        mkdirSync(dirname(peer.root), { mode: 0o700 });
        command(
          "cp",
          ["-a", "--reflink=always", master, peer.root],
          process.env,
        );
        makeTreeOwnerWritable(peer.root);
        const ignorePath = join(peer.root, ".codefoldersyncignore");
        if (existsSync(ignorePath))
          assert.ok(
            lstatSync(ignorePath).isFile() &&
              !lstatSync(ignorePath).isSymbolicLink(),
          );
        const previousIgnore = existsSync(ignorePath)
          ? readFileSync(physical(ignorePath), "utf8")
          : ignoreModule.defaultIgnore;
        writeFileSync(ignorePath, previousIgnore, { mode: 0o600 });
        const home = join(repetitionRoot, name, "home");
        mkdirSync(home, { mode: 0o700 });
        peer.env = {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_STATE_HOME: join(home, "state"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        };
        peer.command = [
          "/usr/bin/env",
          ...Object.entries(peer.env)
            .filter(([key]) =>
              [
                "HOME",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "XDG_STATE_HOME",
                "GIT_CONFIG_GLOBAL",
                "GIT_CONFIG_NOSYSTEM",
                "GIT_TERMINAL_PROMPT",
                "GIT_OPTIONAL_LOCKS",
              ].includes(key),
            )
            .map(([key, value]) => `${key}=${value}`),
          ...spec.command,
        ];
        const branchQuery = spawnSync(
          "git",
          [
            "--no-optional-locks",
            "-C",
            peer.root,
            "symbolic-ref",
            "--short",
            "HEAD",
          ],
          { env: peer.env, encoding: "utf8" },
        );
        assert.ok(branchQuery.status === 0 || branchQuery.status === 1);
        const currentBranch =
          branchQuery.status === 0 ? branchQuery.stdout.trim() : null;
        const branch = defaultBranchOnly
          ? syncPolicy.branch
          : `codex/stress-${name}`;
        if (currentBranch !== branch) {
          git(peer, ["branch", "--force", branch, "HEAD"]);
          git(peer, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
        }
        // Branch preparation changes only this copy's refs, never its original working bytes or index.
        mkdirSync(join(peer.root, probeDirectory), { mode: 0o700 });
        mkdirSync(join(peer.root, ".workspace-sync"), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(
          join(peer.root, ".workspace-sync", "stress-local.txt"),
          `local:${name}\n`,
          { mode: 0o600, flag: "wx" },
        );
        mkdirSync(join(peer.root, ".docs"), { recursive: true, mode: 0o700 });
        const staged = ".docs/codefoldersync-stress-staged.txt";
        writeFileSync(join(peer.root, staged), `staged:${name}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        const publicStagedBytes = Buffer.from(`staged:${name}\n`);
        const blob = git(
          peer,
          ["hash-object", "--no-filters", "--stdin", "-w"],
          publicStagedBytes,
        ).trim();
        assert.match(blob, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
        git(peer, [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},${staged}`,
        ]);
        const outside = await outsideWitness(
          peer.root,
          syncPolicy,
          policy,
          ignoreModule,
        );
        beforeOutside.set(name, outside.witness);
        gitRoots.set(name, outside.gitRoots);
        expectedGit.set(
          name,
          await gitWitness(outside.gitRoots, createTreeWitness),
        );
        peers.push(peer);
      }
      const [source, target] = peers;
      const fleet = {
        schemaVersion: 1,
        runId: childRun.runId,
        expectedVersion: "0.3.0",
        expectedReleaseSha256: spec.candidateSha256,
        folderName: `full-${spec.caseId}`,
        backupWitness: spec.originalSnapshotId ?? "public-fixture",
        controllerStateDir: join(repetitionRoot, "controller"),
        hub: { kind: "local", path: join(repetitionRoot, "hub") },
        syncPolicy,
        authority: source,
        targets: peers.slice(1).map((peer, index) => ({
          ...peer,
          role: index === 0 ? "hub" : "peer",
          requestPath: join(repetitionRoot, peer.machineId, "request.json"),
        })),
      };
      // The packaged setup command accepts an explicit ignore projection; the
      // distributed helper currently activates only the default projection.
      let activation = 0;
      class ScopedExecutor extends processExecutor.ProcessDistributedExecutor {
        async activatePeer(peer, accepted, request) {
          assert.ok(fleet.targets.some((target) => target === peer));
          assert.equal(
            hash(JSON.stringify(readEnrollmentRequest(peer.requestPath))),
            hash(JSON.stringify(request)),
          );
          const acceptedPath = join(
            fleet.controllerStateDir,
            `accepted-activation-${activation++}.json`,
          );
          writeFileSync(acceptedPath, `${JSON.stringify(accepted)}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          const response = JSON.parse(
            command(
              peer.command[0],
              [
                ...peer.command.slice(1),
                "setup",
                "--mode",
                "activate",
                "--accepted-config",
                acceptedPath,
                "--request",
                peer.requestPath,
                "--state",
                peer.stateDir,
                "--config",
                peer.configPath,
                "--ignore",
                join(peer.root, ".codefoldersyncignore"),
              ],
              peer.env,
            ),
          );
          assert.equal(response.configured, true);
          return loadConfig(peer.configPath);
        }
      }
      const executor = new ScopedExecutor();
      const prepared = await distributed.prepareDistributedSetupV3(
        fleet,
        executor,
      );
      for (const peer of prepared.targets) {
        assert.ok(peer.adoptionId);
        await distributed.applyDistributedTargetV3(
          fleet,
          executor,
          peer.machineId,
          peer.adoptionId,
        );
      }
      const config = await executor.cutover(
        source,
        loadConfig(source.configPath),
      );
      for (const peer of fleet.targets)
        await executor.activatePeer(
          peer,
          config,
          readEnrollmentRequest(peer.requestPath),
        );
      const cassette = [];
      const leaf = (suffix) =>
        `${probeDirectory}/${defaultBranchOnly ? "" : ".env."}${suffix}${defaultBranchOnly ? ".txt" : ""}`;
      const bytes = (label) =>
        Buffer.from(`CODEFOLDERSYNC_STRESS=${hash(`${spec.seed}:${label}`)}\n`);
      const write = (peer, path, value, fresh = false) => {
        writeFileSync(join(peer.root, path), value, {
          mode: 0o600,
          ...(fresh ? { flag: "wx" } : {}),
        });
        cassette.push({
          peer: peer.machineId,
          pathHash: hash(path),
          digest: hash(value),
        });
      };
      const sync = async (peer) => {
        const result = await executor.sync(peer, loadConfig(peer.configPath));
        assert.ok(
          ["clean", "conflict"].includes(result.status),
          "Complete folder sync did not converge",
        );
        return result;
      };
      const converge = async () => {
        for (const peer of peers) await sync(peer);
        await sync(source);
      };
      const prove = (path, value) => {
        for (const peer of peers)
          assert.equal(hash(readFileSync(join(peer.root, path))), hash(value));
      };
      const unchangedGit = async () => {
        for (const peer of peers)
          assert.deepEqual(
            await gitWitness(gitRoots.get(peer.machineId), createTreeWitness),
            expectedGit.get(peer.machineId),
          );
      };
      const timings = [];
      const crash = async (peer, point) => {
        let killed = false;
        try {
          await executor.crashSync(
            peer,
            loadConfig(peer.configPath),
            childRun,
            point,
          );
        } catch (error) {
          assert.ok(
            error instanceof processExecutor.DistributedAgentTermination,
          );
          assert.equal(error.signal, "SIGKILL");
          killed = true;
        }
        assert.equal(killed, true);
        const marker = JSON.parse(
          readFileSync(
            processExecutor.acceptanceCrashMarker(peer.stateDir, point),
            "utf8",
          ),
        );
        assert.equal(marker.point, point);
      };
      for (let round = 0; round < spec.rounds; round++) {
        phase = `round-${round}`;
        const started = performance.now();
        const writer = peers[round % peers.length];
        const path = leaf(`round-${round}`);
        const value = bytes(`round-${round}`);
        write(writer, path, value, true);
        await converge();
        prove(path, value);
        await unchangedGit();
        timings.push(Math.round(performance.now() - started));
      }
      const concurrentPath = leaf("concurrent");
      phase = "concurrent-edit";
      write(source, concurrentPath, bytes("initial-concurrent"), true);
      await converge();
      const first = bytes("first-concurrent"),
        losing = bytes("losing-concurrent");
      write(source, concurrentPath, first);
      write(target, concurrentPath, losing);
      await sync(source);
      assert.ok((await sync(target)).conflicts > 0);
      await converge();
      prove(concurrentPath, first);
      for (const peer of peers)
        assert.ok(
          readdirSync(join(peer.root, probeDirectory))
            .filter((name) => name.includes("CODEFOLDERSYNC-CONFLICT"))
            .some(
              (name) =>
                hash(readFileSync(join(peer.root, probeDirectory, name))) ===
                hash(losing),
            ),
        );
      const { HubStore } = await module("hub");
      const normalConflicts = () => {
        const hub = new HubStore(fleet.hub.path);
        try {
          return hub
            .conflicts(config.folderId)
            .filter((record) => record.kind === "normal");
        } finally {
          hub[Symbol.dispose]();
        }
      };
      const remove = (peer, path) => {
        unlinkSync(join(peer.root, path));
        cassette.push({
          operation: "delete",
          peer: peer.machineId,
          pathHash: hash(path),
        });
      };
      const move = (peer, from, to) => {
        renameSync(join(peer.root, from), join(peer.root, to));
        cassette.push({
          operation: "move",
          peer: peer.machineId,
          fromHash: hash(from),
          toHash: hash(to),
        });
      };
      const proveAbsent = (path) => {
        for (const peer of peers)
          assert.equal(existsSync(join(peer.root, path)), false);
      };
      const proveNewConflict = async (previous, expectedBytes) => {
        const targetConfig = loadConfig(target.configPath);
        const record = normalConflicts().find(
          (entry) =>
            !previous.has(entry.conflictId) &&
            entry.peerId === targetConfig.peerId,
        );
        assert.ok(
          record,
          "Concurrent structural intent lacks conflict evidence",
        );
        if (expectedBytes !== undefined) {
          assert.ok(record.manifestId);
          for (const peer of peers)
            assert.ok(
              readdirSync(join(peer.root, probeDirectory)).some(
                (name) =>
                  name.includes("CODEFOLDERSYNC-CONFLICT") &&
                  lstatSync(join(peer.root, probeDirectory, name)).isFile() &&
                  hash(readFileSync(join(peer.root, probeDirectory, name))) ===
                    hash(expectedBytes),
              ),
              "Concurrent structural bytes were not retained on every peer",
            );
          const recovered = join(
            target.stateDir,
            `structural-recovered-${hash(expectedBytes)}.txt`,
          );
          await executor.recoverAcceptanceConflict(
            target,
            targetConfig,
            childRun,
            record.conflictId,
            recovered,
          );
          assert.equal(hash(readFileSync(recovered)), hash(expectedBytes));
        }
      };
      const structuralMatrix = [];
      phase = "matrix-delete-restore";
      const restorePath = leaf("delete-restore");
      const restoreBytes = bytes("delete-restore");
      write(source, restorePath, restoreBytes, true);
      await converge();
      remove(source, restorePath);
      await converge();
      proveAbsent(restorePath);
      for (const peer of peers) {
        const database = new DatabaseSync(join(peer.stateDir, "state.sqlite"), {
          readOnly: true,
        });
        try {
          assert.ok(
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM catalog_history WHERE tombstone=1 AND json_extract(json,'$.path')=?",
              )
              .get(restorePath).count > 0,
          );
        } finally {
          database.close();
        }
      }
      write(source, restorePath, restoreBytes, true);
      await converge();
      prove(restorePath, restoreBytes);
      const historyHub = new HubStore(fleet.hub.path);
      try {
        assert.ok(
          historyHub
            .history(config.folderId)
            .some(
              (event) =>
                typeof event.mutations_json === "string" &&
                JSON.parse(event.mutations_json).some(
                  (mutation) => mutation.kind === "restore-entry",
                ),
            ),
        );
        assert.equal(
          hash(historyHub.objects.get(hash(restoreBytes))),
          hash(restoreBytes),
        );
      } finally {
        historyHub[Symbol.dispose]();
      }
      structuralMatrix.push("delete-restore");

      for (const operation of [
        "delete-edit",
        "edit-delete",
        "move-delete",
        "move-move",
        "move-edit",
      ]) {
        phase = `matrix-${operation}`;
        const path = leaf(operation);
        const moved = leaf(`${operation}-moved`);
        const losingMove = leaf(`${operation}-other-move`);
        const initial = bytes(`${operation}-initial`);
        const edit = bytes(`${operation}-edit`);
        write(source, path, initial, true);
        await converge();
        const previous = new Set(
          normalConflicts().map((record) => record.conflictId),
        );
        if (operation === "delete-edit") {
          remove(source, path);
          write(target, path, edit);
        } else if (operation === "edit-delete") {
          write(source, path, edit);
          remove(target, path);
        } else {
          move(source, path, moved);
          if (operation === "move-delete") remove(target, path);
          else if (operation === "move-move") move(target, path, losingMove);
          else write(target, path, edit);
        }
        await sync(source);
        await sync(target);
        await converge();
        if (operation === "delete-edit") {
          proveAbsent(path);
          await proveNewConflict(previous, edit);
        } else if (operation === "edit-delete") {
          prove(path, edit);
          await proveNewConflict(previous);
        } else {
          proveAbsent(path);
          prove(moved, operation === "move-edit" ? edit : initial);
          if (operation === "move-move")
            await proveNewConflict(previous, initial);
          else if (operation === "move-delete")
            await proveNewConflict(previous);
        }
        await unchangedGit();
        structuralMatrix.push(operation);
      }
      const offlinePath = leaf("offline");
      phase = "hub-offline";
      const heldHub = `${fleet.hub.path}-offline`;
      renameSync(fleet.hub.path, heldHub);
      const marker = "full-folder-hub-offline\n";
      writeFileSync(fleet.hub.path, marker, { mode: 0o600, flag: "wx" });
      try {
        write(target, offlinePath, bytes("offline"), true);
        const unavailable = await executor.sync(
          target,
          loadConfig(target.configPath),
        );
        assert.ok(["offline", "inconclusive"].includes(unavailable.status));
        assert.ok(
          ["offline", "inconclusive"].includes(
            (await executor.verify(target, loadConfig(target.configPath)))
              .status,
          ),
        );
      } finally {
        assert.ok(
          lstatSync(fleet.hub.path).isFile() &&
            lstatSync(fleet.hub.path).nlink === 1,
        );
        assert.equal(readFileSync(fleet.hub.path, "utf8"), marker);
        unlinkSync(fleet.hub.path);
        renameSync(heldHub, fleet.hub.path);
      }
      await converge();
      prove(offlinePath, bytes("offline"));
      for (const point of ["after-outbox", "after-hub-accept"]) {
        phase = `crash-${point}`;
        const path = leaf(point);
        write(source, path, bytes(point), true);
        await crash(source, point);
        await converge();
        prove(path, bytes(point));
      }
      const branchPath = leaf("branch-transition");
      phase = "branch-transition";
      git(source, ["branch", "--force", "codex/stress-switch", "HEAD"]);
      git(source, ["symbolic-ref", "HEAD", "refs/heads/codex/stress-switch"]);
      expectedGit.set(
        source.machineId,
        await gitWitness(gitRoots.get(source.machineId), createTreeWitness),
      );
      write(source, branchPath, bytes("branch-transition"), true);
      const switched = await executor.sync(
        source,
        loadConfig(source.configPath),
      );
      if (defaultBranchOnly) {
        assert.equal(switched.published, false);
        for (const peer of peers.slice(1))
          assert.equal(existsSync(join(peer.root, branchPath)), false);
      } else {
        assert.ok(["clean", "conflict"].includes(switched.status));
        await converge();
        prove(branchPath, bytes("branch-transition"));
      }
      await unchangedGit();
      git(source, [
        "symbolic-ref",
        "HEAD",
        `refs/heads/${defaultBranchOnly ? syncPolicy.branch : "codex/stress-source"}`,
      ]);
      expectedGit.set(
        source.machineId,
        await gitWitness(gitRoots.get(source.machineId), createTreeWitness),
      );
      await converge();
      prove(branchPath, bytes("branch-transition"));
      for (const fault of ["enospc-write", "eio-fsync"]) {
        phase = `native-${fault}`;
        const path = leaf(fault);
        const prior = bytes(`${fault}-prior`),
          desired = bytes(`${fault}-desired`);
        write(source, path, prior, true);
        await converge();
        write(source, path, desired);
        await sync(source);
        const failed = await executor.nativeFaultSync(
          target,
          loadConfig(target.configPath),
          childRun,
          spec.nativeFaultLibrary,
          fault,
        );
        assert.equal(failed.status, "inconclusive");
        assert.ok(
          failed.reasons.some((reason) =>
            reason.includes(fault === "enospc-write" ? "ENOSPC" : "EIO"),
          ),
        );
        const recovered = recoveryProbe(target.stateDir, path);
        assert.equal(hash(readFileSync(recovered)), hash(prior));
        await converge();
        prove(path, desired);
        assert.equal(hash(readFileSync(recovered)), hash(prior));
      }
      const corruptionPath = leaf("corruption");
      phase = "corruption";
      const corruptionBytes = bytes("fresh-corruption");
      write(source, corruptionPath, corruptionBytes, true);
      await sync(source);
      const { ObjectStore } = await module("objects");
      const targetObjects = new ObjectStore(join(target.stateDir, "objects"));
      try {
        assert.equal(targetObjects.has(hash(corruptionBytes)), false);
      } finally {
        targetObjects[Symbol.dispose]();
      }
      replaceProbeObject(
        fleet.hub.path,
        hash(corruptionBytes),
        Buffer.from("deliberate-stress-corruption\n"),
      );
      try {
        assert.equal(
          (await executor.sync(target, loadConfig(target.configPath))).status,
          "inconclusive",
        );
        assert.equal(existsSync(join(target.root, corruptionPath)), false);
        assert.equal(
          (await executor.verify(target, loadConfig(target.configPath))).status,
          "inconclusive",
        );
      } finally {
        replaceProbeObject(
          fleet.hub.path,
          hash(corruptionBytes),
          corruptionBytes,
        );
      }
      await converge();
      prove(corruptionPath, corruptionBytes);
      const movedDirectory = `${probeDirectory}-moved`;
      phase = "directory-move";
      renameSync(
        join(source.root, probeDirectory),
        join(source.root, movedDirectory),
      );
      cassette.push({ operation: "move-complete-probe-subtree" });
      const movement = await sync(source);
      assert.equal(movement.published, true);
      assert.equal(movement.uploadedObjects, 0);
      await crash(target, "after-moves-staged");
      await converge();
      prove(
        leaf("round-0").replace(`${probeDirectory}/`, `${movedDirectory}/`),
        bytes("round-0"),
      );
      await unchangedGit();
      let sequence;
      phase = "final-verification";
      for (const peer of peers) {
        const verified = await executor.verify(
          peer,
          loadConfig(peer.configPath),
        );
        assert.ok(["clean", "conflict"].includes(verified.status));
        if (sequence === undefined) sequence = verified.hubSequence;
        else assert.equal(verified.hubSequence, sequence);
        const unchanged = await sync(peer);
        assert.equal(unchanged.published, false);
        assert.equal(unchanged.uploadedObjects, 0);
        assert.equal(unchanged.downloadedObjects, 0);
        assert.equal(unchanged.hubSequence, sequence);
        const finalOutside = await outsideWitness(
          peer.root,
          syncPolicy,
          policy,
          ignoreModule,
        );
        assert.deepEqual(
          finalOutside.witness,
          beforeOutside.get(peer.machineId),
        );
        for (const repository of finalOutside.repositoryRoots)
          git({ ...peer, root: repository }, ["fsck", "--full"]);
      }
      const allocation = validateBoundedReflinkStorage(spec.storage, [
        repetitionRoot,
      ]);
      results.push({
        repetition,
        rounds: spec.rounds,
        cassetteDigest: hash(JSON.stringify(cassette)),
        fullMaster: beforeMaster,
        policy: syncPolicy.mode,
        distinctBranches: !defaultBranchOnly,
        localGitAndUnselectedBytesPreserved: true,
        gitFsckPassed: true,
        conflictBytesPreserved: true,
        structuralMatrix,
        structuralConflictBytesPrivatelyRecovered: true,
        restoredTombstoneAndImmutableBytesPreserved: true,
        offlineEditRecovered: true,
        processCrashRestartPassed: true,
        branchTransitionPassed: true,
        nativeFilesystemFaults: ["enospc-write", "eio-fsync"],
        fullVerificationPassed: true,
        noChangePeers: 3,
        nativePriorRecoveryPreserved: true,
        corruptionRejectedAndRepaired: true,
        directoryMoveUploadedObjects: 0,
        directoryMoveCrashRestartPassed: true,
        roundDurationsMs: timings,
        maximumTotalBytes: allocation.maximumTotalBytes,
        passed: true,
      });
      storage.cleanupRunRoot(childRun);
    }
    phase = "final-master-witness";
    assert.deepEqual(await createTreeWitness(master), beforeMaster);
    assert.equal(results[0].cassetteDigest, results[1].cassetteDigest);
    mkdirSync(spec.evidenceDirectory, { mode: 0o700 });
    const result = {
      schemaVersion: 1,
      caseId: spec.caseId,
      sourceRelativePath: spec.sourceRelativePath,
      acceptanceCorpus: spec.corpus === "complete-original-folder",
      candidateSha256: spec.candidateSha256,
      originalSnapshotId: spec.originalSnapshotId,
      results,
      passed: true,
    };
    writeFileSync(
      join(spec.evidenceDirectory, "result.json"),
      `${JSON.stringify(result)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return result;
  } catch (error) {
    const location = String(error?.stack).match(
      /run_full_folder_stress\.mjs:(\d+)/u,
    );
    const failure = {
      phase,
      module: "run_full_folder_stress.mjs",
      line: Number(location?.[1] ?? 0),
      code: ["ERR_ASSERTION", "ENOSPC", "EIO", "EACCES", "EPERM"].includes(
        error?.code,
      )
        ? error.code
        : "unknown",
    };
    process.stderr.write(
      `CFS_FOLDER_STRESS_FAILURE ${JSON.stringify(failure)}\n`,
    );
    throw new Error("Full-folder stress failed", {
      cause: { folderStressFailure: failure, originalError: error },
    });
  } finally {
    storage.cleanupRunRoot(run);
  }
}

function git(peer, args, input) {
  return command(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      "-C",
      peer.root,
      ...args,
    ],
    peer.env,
    input,
  );
}
async function gitWitness(roots, createTreeWitness) {
  const values = [];
  for (const root of roots.sort())
    values.push(
      lstatSync(root).isDirectory()
        ? await createTreeWitness(root)
        : { digest: await fileHash(root), mode: lstatSync(root).mode & 0o7777 },
    );
  return hash(JSON.stringify(values));
}
async function outsideWitness(root, policy, policyModule, ignoreModule) {
  const ignorePath = join(root, ".codefoldersyncignore");
  if (existsSync(ignorePath))
    assert.ok(
      lstatSync(ignorePath).isFile() && !lstatSync(ignorePath).isSymbolicLink(),
    );
  const ignore = ignoreModule.compileIgnore(
    existsSync(ignorePath)
      ? readFileSync(physical(ignorePath), "utf8")
      : ignoreModule.defaultIgnore,
  );
  const digest = createHash("sha256");
  let files = 0,
    bytes = 0;
  const gitSet = new Set();
  const repositoryContexts = new Map();
  const device = lstatSync(root).dev;
  const discover = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry),
        stat = lstatSync(path);
      assert.equal(stat.dev, device);
      const local = relative(root, path).split(sep).join("/");
      if (
        [".codefoldersync", ".codefoldersyncignore"].includes(
          local.toLowerCase(),
        )
      )
        continue;
      if (entry.toLowerCase() === ".git") {
        assert.equal(stat.isSymbolicLink(), false);
        gitSet.add(physical(path));
        const repositoryPath = relative(root, directory).split(sep).join("/");
        for (const metadata of policyModule.repositoryMetadata(
          root,
          repositoryPath,
        ).metadataPaths)
          gitSet.add(physical(metadata));
        let eligible = true;
        if (policy.mode === "default-branch") {
          try {
            const context = policyModule.inspectRepositoryContext(
              root,
              repositoryPath,
            );
            eligible =
              context.branch === policy.branch && context.head !== null;
          } catch {
            eligible = false;
          }
        }
        repositoryContexts.set(repositoryPath, eligible);
      } else if (stat.isDirectory() && !ignore.ignores(local, true))
        discover(path);
    }
  };
  discover(root);
  const gitRoots = [...gitSet].filter(
    (path) =>
      ![...gitSet].some(
        (other) => other !== path && path.startsWith(`${other}${sep}`),
      ),
  );
  const visit = async (directory, excluded = false) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry),
        stat = lstatSync(path),
        local = relative(root, path).split(sep).join("/");
      assert.equal(stat.dev, device);
      if (
        [".codefoldersync", ".codefoldersyncignore"].includes(
          local.toLowerCase(),
        )
      )
        continue;
      if (
        gitRoots.some(
          (metadata) =>
            path === metadata || path.startsWith(`${metadata}${sep}`),
        )
      )
        continue;
      const ignored = excluded || ignore.ignores(local, stat.isDirectory());
      if (stat.isDirectory()) {
        if (ignored)
          digest.update(
            JSON.stringify([local, "directory", stat.mode & 0o7777]),
          );
        await visit(path, ignored);
        continue;
      }
      const owner = [...repositoryContexts.entries()]
        .filter(
          ([repository]) =>
            repository === "" || local.startsWith(`${repository}/`),
        )
        .sort(([left], [right]) => right.length - left.length)[0];
      if (
        !ignored &&
        owner?.[1] !== false &&
        policyModule.policyIncludes(policy, local)
      )
        continue;
      assert.ok(stat.isFile() || stat.isSymbolicLink());
      files++;
      bytes += stat.size;
      digest.update(
        JSON.stringify([
          local,
          stat.mode & 0o7777,
          stat.isSymbolicLink() ? readlinkSync(path) : await fileHash(path),
        ]),
      );
    }
  };
  await visit(root);
  return {
    witness: { digest: digest.digest("hex"), files, bytes },
    gitRoots,
    repositoryRoots: [...repositoryContexts.keys()].map((path) =>
      join(root, path),
    ),
  };
}

function replaceProbeObject(hub, id, bytes) {
  const database = new DatabaseSync(join(hub, "objects/objects.sqlite"));
  try {
    assert.equal(
      database.prepare("UPDATE objects SET bytes=? WHERE id=?").run(bytes, id)
        .changes,
      1,
    );
  } finally {
    database.close();
  }
}
function recoveryProbe(stateDir, local) {
  const database = new DatabaseSync(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });
  let journal;
  try {
    const row = database
      .prepare("SELECT json FROM journals WHERE kind='snapshot-apply'")
      .get();
    assert.equal(typeof row?.json, "string");
    journal = JSON.parse(row.json);
  } finally {
    database.close();
  }
  assert.equal(typeof journal.recoveryRoot, "string");
  assert.ok(journal.recoveryRoot.startsWith(`${physical(stateDir)}${sep}`));
  physical(journal.recoveryRoot);
  const path = join(journal.recoveryRoot, local);
  physical(path);
  assert.ok(lstatSync(path).isFile());
  return path;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runFullFolderStress(
      JSON.parse(readFileSync(physical(process.argv[2]), "utf8")),
    );
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        caseId: result.caseId,
        passed: true,
        acceptanceCorpus: result.acceptanceCorpus,
      }),
    );
  } catch {
    process.stderr.write(`Full-folder stress failed at ${phase}.\n`);
    process.exitCode = 1;
  }
}
