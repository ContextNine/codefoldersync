import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ObjectStore } from "../../dist/v3/objects.js";
import { createTreeWitness } from "../../dist/v3/acceptance.js";
import { seedAcceptanceObjectTemplate } from "../../dist/v3/acceptance-reflink.js";

const [inheritedNamespace, uidText, gidText] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.match(inheritedNamespace ?? "", /^mnt:\[\d+\]$/u);
assert.notEqual(readlinkSync("/proc/self/ns/mnt"), inheritedNamespace);
const uid = Number(uidText);
const gid = Number(gidText);
assert.ok(Number.isSafeInteger(uid) && uid > 0);
assert.ok(Number.isSafeInteger(gid) && gid > 0);
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const imageMaximumBytes = 1024 ** 3;

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} failed: ${result.stderr}`);
  return result.stdout;
}

function ownTree(path) {
  const stat = lstatSync(path);
  chownSync(path, uid, gid);
  if (stat.isDirectory())
    for (const name of readdirSync(path)) ownTree(join(path, name));
}

function exclusiveBytes(path) {
  const output = command("btrfs", ["filesystem", "du", "--raw", "-s", path]);
  const line = output
    .split("\n")
    .find((item) => /^\s*\d+\s+\d+\s+\d+/u.test(item));
  assert.ok(line !== undefined);
  return Number(line.trim().split(/\s+/u)[1]);
}

const root = mkdtempSync(join(tmpdir(), "codefoldersync-reflink-probe-"));
chownSync(root, uid, gid);
const sentinel = "private-reflink-capability-v1\n";
const mountpoint = join(root, "filesystem");
let mounted = false;
const residue = mkdtempSync(join(tmpdir(), "codefoldersync-reflink-residue-"));
chownSync(residue, uid, gid);
const controllerFixture = mkdtempSync(
  join(tmpdir(), "codefoldersync-controller-public-"),
);
try {
  writeFileSync(join(root, "SENTINEL"), sentinel, { mode: 0o600 });
  chownSync(join(root, "SENTINEL"), uid, gid);
  const image = join(root, "fresh-filesystem.img");
  const fd = openSync(image, "wx", 0o600);
  ftruncateSync(fd, imageMaximumBytes);
  closeSync(fd);
  assert.ok(lstatSync(image).isFile() && !lstatSync(image).isSymbolicLink());
  // Format only this newly created image, never a block device or existing file.
  command("mkfs.btrfs", ["--nodiscard", image]);
  mkdirSync(mountpoint);
  command("mount", [
    "-t",
    "btrfs",
    "-o",
    "loop,compress=zstd:3",
    image,
    mountpoint,
  ]);
  mounted = true;
  chownSync(mountpoint, uid, gid);
  chmodSync(mountpoint, 0o700);
  const master = join(mountpoint, "master");
  const sourceFile = join(master, "Code/folder/payload.bin");
  mkdirSync(dirname(sourceFile), { recursive: true });
  const payload = randomBytes(2 * 1024 ** 2);
  writeFileSync(sourceFile, payload, { mode: 0o444 });
  const sourceObjects = join(master, "state/objects");
  const base = new ObjectStore(sourceObjects);
  const id = base.put(payload);
  base[Symbol.dispose]();
  ownTree(master);
  const database = join(sourceObjects, "objects.sqlite");
  chmodSync(database, 0o400);
  for (const path of [
    master,
    join(master, "Code"),
    join(master, "Code/folder"),
    join(master, "state"),
    sourceObjects,
  ])
    chmodSync(path, 0o500);
  const originalDatabase = createHash("sha256")
    .update(readFileSync(database))
    .digest("hex");
  const peers = [join(mountpoint, "peer-a"), join(mountpoint, "peer-b")];
  for (const peer of peers) {
    command("cp", ["-a", "--reflink=always", master, peer]);
    for (const path of [
      peer,
      join(peer, "Code"),
      join(peer, "Code/folder"),
      join(peer, "state"),
      join(peer, "state/objects"),
    ])
      chmodSync(path, 0o700);
    chmodSync(join(peer, "state/objects/objects.sqlite"), 0o600);
    assert.notEqual(
      lstatSync(join(peer, "state/objects/objects.sqlite")).ino,
      lstatSync(database).ino,
    );
    assert.notEqual(
      lstatSync(join(peer, "Code/folder/payload.bin")).ino,
      lstatSync(sourceFile).ino,
    );
    assert.equal(
      lstatSync(join(peer, "Code")).dev,
      lstatSync(join(peer, "state")).dev,
    );
    chmodSync(join(peer, "Code/folder/payload.bin"), 0o644);
  }
  const copiedStoreExclusiveBytes = peers.map((peer) =>
    exclusiveBytes(join(peer, "state/objects")),
  );
  assert.ok(copiedStoreExclusiveBytes.every((bytes) => bytes < 64 * 1024));
  assert.notEqual(
    lstatSync(join(peers[0], "state/objects/objects.sqlite")).ino,
    lstatSync(join(peers[1], "state/objects/objects.sqlite")).ino,
  );

  const materialized = join(peers[0], "Code/materialized.bin");
  writeFileSync(materialized, payload, { mode: 0o644 });
  command("sync", ["-f", materialized]);
  const materializedBefore = exclusiveBytes(materialized);
  assert.ok(materializedBefore >= payload.length);
  const dedupe = join(root, "dedupe-fixture");
  command("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(fixtureDirectory, "reflink-dedupe.c"),
    "-o",
    dedupe,
  ]);
  const kernelProof = JSON.parse(command(dedupe, [sourceFile, materialized]));
  assert.equal(kernelProof.kernelVerifiedDeduplicatedBytes, payload.length);
  const materializedAfter = exclusiveBytes(materialized);
  assert.equal(materializedAfter, 0);
  ownTree(peers[0]);
  const objectModule = pathToFileURL(
    fileURLToPath(new URL("../../dist/v3/objects.js", import.meta.url)),
  ).href;
  const writer = `import { writeFileSync, renameSync } from 'node:fs';
import { ObjectStore } from ${JSON.stringify(objectModule)};
const peer = process.argv[1];
const objects = new ObjectStore(peer + '/state/objects');
objects.put(Buffer.from('private-database-change'));
objects[Symbol.dispose]();
writeFileSync(peer + '/Code/folder/payload.bin', 'private-file-change');
writeFileSync(peer + '/Code/materialized.bin', 'private-deduped-change');
renameSync(peer + '/Code/folder', peer + '/Code/renamed');`;
  command("setpriv", [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    process.execPath,
    "--input-type=module",
    "-e",
    writer,
    peers[0],
  ]);
  const peerA = new ObjectStore(join(peers[0], "state/objects"));
  const peerB = new ObjectStore(join(peers[1], "state/objects"));
  const privateId = createHash("sha256")
    .update("private-database-change")
    .digest("hex");
  assert.equal(peerA.has(privateId), true);
  assert.equal(peerB.has(privateId), false);
  assert.deepEqual(peerA.get(id), payload);
  assert.deepEqual(peerB.get(id), payload);
  peerA[Symbol.dispose]();
  peerB[Symbol.dispose]();
  assert.equal(
    createHash("sha256").update(readFileSync(database)).digest("hex"),
    originalDatabase,
  );
  assert.deepEqual(readFileSync(sourceFile), payload);
  assert.equal(lstatSync(sourceFile).mode & 0o777, 0o444);
  assert.equal(lstatSync(database).mode & 0o777, 0o400);
  assert.deepEqual(
    readFileSync(join(peers[1], "Code/folder/payload.bin")),
    payload,
  );
  assert.equal(
    readFileSync(join(peers[0], "Code/renamed/payload.bin"), "utf8"),
    "private-file-change",
  );
  assert.equal(readFileSync(materialized, "utf8"), "private-deduped-change");

  // Exercise the actual bounded runner, not only the underlying filesystem.
  const masters = [];
  for (const machineId of ["mattbook", "wootbook", "workermacair"]) {
    const code = join(mountpoint, "masters", machineId, "Code");
    mkdirSync(dirname(code), { recursive: true });
    command("cp", ["-a", "--reflink=always", join(master, "Code"), code]);
    ownTree(join(mountpoint, "masters", machineId));
    masters.push({
      machineId,
      root: code,
      witness: await createTreeWitness(code),
    });
  }
  const templateDirectory = join(mountpoint, "object-template");
  const seeded = seedAcceptanceObjectTemplate(
    masters.map((item) => item.root),
    templateDirectory,
  );
  assert.equal(seeded.capturedLeaves, 3);
  assert.ok(seeded.objects > 1);
  ownTree(templateDirectory);
  const releaseSha256 = "d".repeat(64);
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const nativeLibrary = join(root, "native-filesystem-fault.so");
  command("cc", [
    "-shared",
    "-fPIC",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    nativeLibrary,
    join(repository, "test/fixtures/filesystem-fault.c"),
  ]);
  chownSync(nativeLibrary, uid, gid);
  chmodSync(nativeLibrary, 0o500);
  const nativeFaultLibrary = {
    path: nativeLibrary,
    sha256: createHash("sha256")
      .update(readFileSync(nativeLibrary))
      .digest("hex"),
  };
  const installation = join(mountpoint, "test-install");
  command(process.execPath, [
    join(repository, "dist/product-cli.js"),
    "install",
    "--built",
    join(repository, "dist"),
    "--install-root",
    join(installation, "lib"),
    "--bin-dir",
    join(installation, "bin"),
    "--release-sha256",
    releaseSha256,
  ]);
  ownTree(installation);
  const runId = "reflink-runner-probe";
  const runRoot = join(mountpoint, "run-full-fixture");
  mkdirSync(runRoot, { mode: 0o700 });
  writeFileSync(join(runRoot, "SENTINEL"), `${runId}\n`, { mode: 0o600 });
  ownTree(runRoot);
  const spec = {
    schemaVersion: 1,
    runId,
    scenarioId: "reflink-fixture",
    seed: "public-fixture-only",
    repetitions: 2,
    runRoot,
    evidenceDirectory: join(mountpoint, "runner-evidence"),
    expectedVersion: "0.3.0",
    expectedReleaseSha256: releaseSha256,
    command: [join(installation, "bin/codefoldersync")],
    backupWitness: "public-fixture-only-not-archived-acceptance",
    sourceMachineId: "mattbook",
    targetOrder: ["wootbook", "workermacair"],
    hubMachineId: "wootbook",
    masters,
    nativeFaultLibrary,
    storage: {
      kind: "bounded-reflink",
      volumeRunId: "private-reflink-capability-v1",
      volumeRunRoot: root,
      imagePath: image,
      mountRoot: mountpoint,
      maximumImageBytes: imageMaximumBytes,
      inheritedMountNamespace: inheritedNamespace,
      retainedRoots: [residue],
      objectTemplate: join(templateDirectory, "objects.sqlite"),
    },
  };
  const acceptanceModule = pathToFileURL(
    join(repository, "dist/v3/acceptance.js"),
  ).href;
  const storageModule = pathToFileURL(
    join(repository, "dist/v3/acceptance-reflink.js"),
  ).href;
  const runner = `import assert from 'node:assert/strict';
import { runPseudoFleetAcceptanceV3 } from ${JSON.stringify(acceptanceModule)};
import { validateBoundedReflinkStorage } from ${JSON.stringify(storageModule)};
const spec = ${JSON.stringify(spec)};
assert.throws(() => validateBoundedReflinkStorage({...spec.storage, maximumImageBytes: spec.storage.maximumImageBytes + 1}, [spec.runRoot]));
assert.throws(() => validateBoundedReflinkStorage({...spec.storage, retainedRoots: [spec.storage.volumeRunRoot]}, [spec.runRoot]));
assert.throws(() => validateBoundedReflinkStorage(spec.storage, [spec.storage.retainedRoots[0]]));
const results = await runPseudoFleetAcceptanceV3(spec);
console.log(JSON.stringify(results));`;
  const results = JSON.parse(
    command("setpriv", [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      process.execPath,
      "--input-type=module",
      "-e",
      runner,
    ]),
  );
  assert.equal(results.length, 2);
  for (const result of results)
    assert.deepEqual(result.faults.nativeFilesystemFaults, [
      "enospc-write",
      "eio-fsync",
    ]);
  assert.ok(
    results.every((result) => result.passed && result.storage.objectsPreseeded),
  );
  assert.equal(
    results[0].workload.cassetteDigest,
    results[1].workload.cassetteDigest,
  );
  for (const result of results)
    assert.ok(
      Object.values(result.targetDigests).every(
        (digest) => digest === result.sourceDigest,
      ),
    );
  assert.throws(() => lstatSync(runRoot), { code: "ENOENT" });

  writeFileSync(
    join(controllerFixture, "SENTINEL"),
    "public-archived-controller-fixture\n",
    { mode: 0o600 },
  );
  const identity = join(controllerFixture, "fixture.agekey");
  command("age-keygen", ["--output", identity]);
  const recipient = command("age-keygen", ["--y", identity]).trim();
  const sources = [];
  for (const machineId of ["mattbook", "wootbook", "workermacair"]) {
    const bundle = join(controllerFixture, machineId);
    mkdirSync(bundle, { mode: 0o700 });
    const archiveName = `${machineId}-code.tar.zst.age`;
    const archive = join(bundle, archiveName);
    command("bash", [
      "-o",
      "pipefail",
      "-c",
      'tar -cf - -C "$1" Code | zstd --quiet --stdout | age --recipient "$2" --output "$3"',
      "public-fixture",
      master,
      recipient,
      archive,
    ]);
    const bytes = lstatSync(archive).size;
    const sha256 = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    writeFileSync(
      join(bundle, "witness.json"),
      JSON.stringify({
        schema_version: 1,
        snapshot_id: "public-controller-snapshot",
        machine_id: machineId,
        artifacts: [{ name: archiveName, size: bytes, sha256 }],
      }),
      { mode: 0o600 },
    );
    sources.push({
      machineId,
      archiveName,
      bytes,
      sha256,
      recoveryVerified: true,
      remoteDownloadedContentVerified: true,
      witness: masters[0].witness,
    });
  }
  const candidateDirectory = join(controllerFixture, "candidate");
  command("python3", [
    join(repository, "scripts/build_release.py"),
    "--output-dir",
    candidateDirectory,
  ]);
  const candidateArchive = join(
    candidateDirectory,
    "codefoldersync-0.3.0.tar.gz",
  );
  const candidateSha256 = createHash("sha256")
    .update(readFileSync(candidateArchive))
    .digest("hex");
  const stressControl = join(root, "full-folder-stress-control.json");
  writeFileSync(
    stressControl,
    JSON.stringify({
      uid,
      runId: sentinel.trim(),
      outer: root,
      image,
      mount: mountpoint,
      maximumImageBytes: imageMaximumBytes,
      inheritedMountNamespace: inheritedNamespace,
      retainedRoots: [controllerFixture, residue],
      candidateArchive,
      candidateSha256,
      nativeFaultLibrary,
    }),
    { mode: 0o600 },
  );
  chownSync(stressControl, uid, gid);
  const stressMechanics = JSON.parse(
    command("setpriv", [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      process.execPath,
      join(fixtureDirectory, "full-folder-stress.mjs"),
      stressControl,
    ]),
  );
  assert.equal(stressMechanics.originalArchiveAcceptance, false);
  assert.equal(stressMechanics.publicDriverMechanics.length, 2);
  const controllerSpec = join(controllerFixture, "controller-spec.json");
  writeFileSync(
    controllerSpec,
    JSON.stringify({
      schemaVersion: 1,
      corpus: "public-fixture",
      runId: "public-controller-fixture",
      snapshotId: "public-controller-snapshot",
      uid,
      gid,
      inheritedMountNamespace: inheritedNamespace,
      identityPath: identity,
      candidateArchive,
      candidateSha256,
      nativeFaultLibrary,
      sources,
      allocationLimitBytes: 512 * 1024 ** 2,
      seed: "public-controller-only",
      runParent: tmpdir(),
      retainedRoots: [controllerFixture, residue],
      evidenceDirectory: join(controllerFixture, "controller-evidence"),
      downloadCommand: [
        realpathSync("/usr/bin/sudo"),
        "-n",
        "nsenter",
        "--mount",
        "--target",
        "1",
        "setpriv",
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        process.execPath,
        join(repository, "test/fixtures/copy-download.mjs"),
        controllerFixture,
      ],
    }),
    { mode: 0o600 },
  );
  ownTree(controllerFixture);
  const controllerResult = JSON.parse(
    command(process.execPath, [
      join(repository, "scripts/run_bounded_archived_acceptance.mjs"),
      "controller",
      controllerSpec,
    ]),
  );
  assert.equal(controllerResult.passed, true);
  assert.equal(controllerResult.cleaned, true);
  const controllerEvidence = JSON.parse(
    readFileSync(
      join(controllerFixture, "controller-evidence/controller-result.json"),
      "utf8",
    ),
  );
  assert.equal(controllerEvidence.acceptanceCorpus, false);
  assert.equal(controllerEvidence.historicalTrees.length, 3);
  assert.equal(controllerEvidence.repetitions.length, 2);
  assert.ok(controllerEvidence.maximumTotalBytes <= 512 * 1024 ** 2);
  const failureSpec = join(controllerFixture, "failure-spec.json");
  const failedEvidence = join(controllerFixture, "failed-evidence");
  const originalControllerSpec = JSON.parse(
    readFileSync(controllerSpec, "utf8"),
  );
  writeFileSync(
    failureSpec,
    JSON.stringify({
      ...originalControllerSpec,
      runId: "public-controller-failure",
      evidenceDirectory: failedEvidence,
      downloadCommand: [
        ...originalControllerSpec.downloadCommand,
        "--corrupt-download",
      ],
    }),
    { mode: 0o600 },
  );
  chownSync(failureSpec, uid, gid);
  const rejected = spawnSync(
    process.execPath,
    [
      join(repository, "scripts/run_bounded_archived_acceptance.mjs"),
      "controller",
      failureSpec,
    ],
    { encoding: "utf8" },
  );
  assert.equal(rejected.status, 1);
  const rejectedEvidence = JSON.parse(
    readFileSync(join(failedEvidence, "controller-result.json"), "utf8"),
  );
  assert.equal(rejectedEvidence.passed, false);
  assert.equal(rejectedEvidence.cleaned, true);
  for (const source of sources)
    assert.equal(
      createHash("sha256")
        .update(
          readFileSync(
            join(controllerFixture, source.machineId, source.archiveName),
          ),
        )
        .digest("hex"),
      source.sha256,
    );
  command("sync", ["-f", mountpoint]);
  command("fstrim", [mountpoint]);
  const imageAllocatedBytes = lstatSync(image).blocks * 512;
  assert.ok(imageAllocatedBytes < 64 * 1024 ** 2);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      privateNamespace: true,
      independentFullFixtureViews: true,
      distinctInodes: true,
      sameFilesystemWorkspaceAndState: true,
      copyOnWriteObjectDatabases: true,
      sqliteWritesIsolated: true,
      kernelVerifiedFileDeduplication: true,
      dedupedWritesIsolated: true,
      directoryRename: true,
      unprivilegedWrites: true,
      unchangedMaster: true,
      copiedStoreExclusiveBytes,
      materializedBefore,
      materializedAfter,
      imageAllocatedBytes,
      boundedRunnerRepetitions: results.length,
      fullFolderStressMechanics: stressMechanics.publicDriverMechanics,
      boundedRunnerConverged: true,
      boundedRunnerCleanup: true,
      objectsPreseeded: true,
      historicalControllerFixture: true,
      outsideNamespaceDownloads: true,
      sequentialCiphertextSlotsCleaned: true,
      controllerVolumeCleaned: true,
      corruptedDownloadRejectedAndCleaned: true,
      originalFixtureCiphertextUnchanged: true,
      acceptanceCorpus: false,
    }) + "\n",
  );
} finally {
  if (mounted) command("umount", [mountpoint]);
  assert.equal(readFileSync(join(root, "SENTINEL"), "utf8"), sentinel);
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  rmSync(root, { recursive: true });
  rmSync(residue, { recursive: true });
  rmSync(controllerFixture, { recursive: true });
}
