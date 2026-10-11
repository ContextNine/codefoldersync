import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  createReadStream,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupRunRoot,
  inspectPhysicalTree,
  storageLimits,
} from "../dist/v3/storage.js";
import { runFullFolderStress } from "./run_full_folder_stress.mjs";

const [role, specPath] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const children = new Set();
let phase = "preflight";
let interrupted = false;
let spec;
const reserve = 64 * 1024 ** 2;
const physical = (path) => {
  assert.ok(
    typeof path === "string" && isAbsolute(path) && resolve(path) === path,
  );
  assert.equal(realpathSync(path), path);
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  return path;
};
const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(physical(path)))
    hash.update(chunk);
  return hash.digest("hex");
};
const readJson = (path) => JSON.parse(readFileSync(physical(path), "utf8"));
const writeJson = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  if (process.getuid() === 0) chownSync(path, spec.uid, spec.gid);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });

// Managed transfers may be broker-owned. Drain every command before unmounting.
async function command(program, args, options = {}) {
  assert.equal(interrupted, false, "Controller interrupted");
  const child = spawn(program, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  const chunks = [];
  let bytes = 0;
  child.stdout.on("data", (part) => {
    bytes += part.length;
    if (bytes <= 1024 ** 2) chunks.push(part);
  });
  child.stderr.on("data", () => {});
  try {
    const status = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(status, 0, "Private stress command failed");
    assert.ok(bytes <= 1024 ** 2, "Private stress output exceeded its bound");
    assert.equal(interrupted, false, "Controller interrupted");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    children.delete(child);
  }
}

async function validate() {
  assert.equal(spec.schemaVersion, 1);
  assert.match(spec.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u);
  assert.ok(
    ["complete-original-folder", "public-fixture"].includes(spec.corpus),
  );
  assert.ok(Number.isSafeInteger(spec.uid) && spec.uid > 0);
  assert.ok(Number.isSafeInteger(spec.gid) && spec.gid > 0);
  assert.match(spec.inheritedMountNamespace, /^mnt:\[\d+\]$/u);
  assert.notEqual(
    readlinkSync("/proc/self/ns/mnt"),
    spec.inheritedMountNamespace,
  );
  assert.notEqual(
    readlinkSync("/proc/self/ns/mnt"),
    readlinkSync("/proc/1/ns/mnt"),
  );
  assert.match(spec.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(await digest(spec.candidateArchive), spec.candidateSha256);
  assert.ok(
    Number.isSafeInteger(spec.maximumImageBytes) &&
      spec.maximumImageBytes >= 256 * 1024 ** 2,
  );
  assert.equal(spec.maximumImageBytes % 4096, 0);
  assert.ok(spec.maximumImageBytes <= storageLimits.wootbookHardBytes);
  const source = spec.source;
  assert.equal(source.machineId, "wootbook");
  assert.equal(source.recoveryVerified, true);
  assert.equal(source.remoteDownloadedContentVerified, true);
  assert.match(source.sha256, /^[a-f0-9]{64}$/u);
  assert.match(
    source.archiveName,
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst\.age$/u,
  );
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
  assert.equal(source.witness.schemaVersion, 1);
  assert.match(source.witness.digest, /^[a-f0-9]{64}$/u);
  const identity = lstatSync(physical(spec.identityPath));
  assert.ok(
    identity.isFile() &&
      (identity.mode & 0o077) === 0 &&
      identity.uid === spec.uid,
  );
  assert.ok(
    Array.isArray(spec.downloadCommand) && spec.downloadCommand.length > 0,
  );
  for (const argument of spec.downloadCommand)
    assert.equal(typeof argument, "string");
  physical(spec.downloadCommand[0]);
  assert.equal(await digest(spec.restoreScript), spec.restoreScriptSha256);
  const fault = lstatSync(physical(spec.nativeFaultLibrary.path));
  assert.ok(fault.isFile() && (fault.mode & 0o222) === 0);
  assert.equal(
    await digest(spec.nativeFaultLibrary.path),
    spec.nativeFaultLibrary.sha256,
  );
  assert.ok(Array.isArray(spec.retainedRoots) && spec.retainedRoots.length > 0);
  const roots = spec.retainedRoots.map(physical);
  const parent = physical(spec.runParent);
  assert.notEqual(parent, sep);
  for (const [index, root] of roots.entries()) {
    assert.equal(root.split(sep).includes("Code"), false);
    assert.ok(root !== parent && !parent.startsWith(`${root}${sep}`));
    assert.ok(
      !roots.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (root === other || root.startsWith(`${other}${sep}`)),
      ),
    );
  }
  assert.equal(parent.split(sep).includes("Code"), false);
  assert.equal(spec.evidenceDirectory.split(sep).includes("Code"), false);
  physical(dirname(spec.evidenceDirectory));
  assert.equal(existsSync(spec.evidenceDirectory), false);
  if (spec.corpus === "complete-original-folder") {
    assert.equal(spec.snapshotId, "codefoldersync-backup-20260825T102132Z");
    const original = readJson(spec.originalAcceptanceReceipt);
    assert.equal(original.passed, true);
    assert.equal(original.acceptanceCorpus, true);
    assert.equal(original.candidateSha256, spec.candidateSha256);
    const parentWitness = original.historicalTrees.find(
      (entry) => entry.machineId === "wootbook",
    );
    assert.ok(parentWitness);
    assert.deepEqual(parentWitness.witness, source.witness);
    const scoped = readJson(spec.originalFolderWitnessReceipt);
    assert.equal(scoped.parentFullTreeVerified, true);
    assert.equal(scoped.snapshotId, spec.snapshotId);
    assert.equal(scoped.sourceMachineId, "wootbook");
    assert.equal(scoped.candidateSha256, spec.candidateSha256);
    assert.deepEqual(scoped.parentWitness, source.witness);
    assert.deepEqual(scoped.folders.map((folder) => folder.caseId).sort(), [
      "impression",
      "verascient",
    ]);
  }
}

async function unprivileged(program, args) {
  return JSON.parse(
    await command("setpriv", [
      `--reuid=${spec.uid}`,
      `--regid=${spec.gid}`,
      "--clear-groups",
      process.execPath,
      program,
      ...args,
    ]),
  );
}

/** Own one complete parent restore, sequential stress cases, and exact volume removal. */
async function controller() {
  assert.equal(process.getuid(), 0);
  await validate();
  const retainedBytes = spec.retainedRoots.reduce(
    (sum, root) => sum + inspectPhysicalTree(root).allocatedBytes,
    0,
  );
  const maximumTotalBytes = retainedBytes + spec.maximumImageBytes + reserve;
  assert.ok(maximumTotalBytes <= storageLimits.wootbookHardBytes);
  const downloadReserve =
    Math.ceil((spec.source.bytes + reserve) / 4096) * 4096;
  const restoreMaximum = spec.maximumImageBytes - downloadReserve;
  assert.ok(restoreMaximum >= 256 * 1024 ** 2);
  const available = statfsSync(spec.runParent);
  assert.ok(
    available.bavail * available.bsize >=
      spec.maximumImageBytes + downloadReserve,
  );
  const outer = mkdtempSync(join(spec.runParent, `run-${spec.runId}-`));
  chownSync(outer, spec.uid, spec.gid);
  const image = join(outer, "acceptance.img");
  const mount = join(outer, "filesystem");
  let mounted = false;
  let passed = false;
  let result;
  try {
    writeFileSync(join(outer, "SENTINEL"), `${spec.runId}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chownSync(join(outer, "SENTINEL"), spec.uid, spec.gid);
    const fd = openSync(image, "wx", 0o600);
    try {
      ftruncateSync(fd, restoreMaximum);
    } finally {
      closeSync(fd);
    }
    await command("mkfs.btrfs", ["--nodiscard", image]);
    mkdirSync(mount, { mode: 0o700 });
    await command("mount", [
      "-t",
      "btrfs",
      "-o",
      "loop,compress=zstd:3",
      image,
      mount,
    ]);
    mounted = true;
    chownSync(mount, spec.uid, spec.gid);
    const control = {
      ...spec,
      outer,
      image,
      mount,
      sources: [spec.source],
      retainedBytes,
    };
    const restoreControl = join(outer, "restore-control.json");
    writeJson(restoreControl, control);
    phase = "complete-parent-restore";
    assert.equal(await digest(spec.restoreScript), spec.restoreScriptSha256);
    const restored = await unprivileged(spec.restoreScript, [
      "restore",
      restoreControl,
    ]);
    assert.equal(restored.passed, true);
    assert.equal(restored.historicalFormat, true);
    assert.equal(restored.masters.length, 1);
    assert.equal(restored.masters[0].machineId, "wootbook");
    assert.deepEqual(restored.masters[0].witness, spec.source.witness);
    phase = "post-download-resize";
    assert.equal(existsSync(join(outer, "download-wootbook")), false);
    const mountedFs = JSON.parse(
      await command("findmnt", [
        "--json",
        "--mountpoint",
        mount,
        "-o",
        "SOURCE",
      ]),
    );
    const device = mountedFs.filesystems?.[0]?.source;
    assert.match(device, /^\/dev\/loop\d+$/u);
    const backing = JSON.parse(
      await command("losetup", [
        "--json",
        "--list",
        "--output",
        "BACK-FILE",
        device,
      ]),
    );
    assert.equal(backing.loopdevices?.[0]?.["back-file"], image);
    const fdGrow = openSync(image, "r+");
    try {
      ftruncateSync(fdGrow, spec.maximumImageBytes);
    } finally {
      closeSync(fdGrow);
    }
    await command("losetup", ["--set-capacity", device]);
    await command("btrfs", ["filesystem", "resize", "max", mount]);
    const runControl = join(outer, "run-control.json");
    writeJson(runControl, { ...control, restored });
    phase = "complete-folder-stress";
    result = await unprivileged(script, ["run", runControl]);
    assert.equal(result.passed, true);
    await command("sync", ["-f", mount]);
    await command("fstrim", [mount]);
    result.imageAllocatedBytes = lstatSync(image).blocks * 512;
    result.maximumTotalBytes = maximumTotalBytes;
    passed = true;
  } finally {
    assert.equal(children.size, 0);
    interrupted = false;
    if (mounted) await command("umount", [mount]);
    const cleaned = cleanupRunRoot({
      schemaVersion: 1,
      runId: spec.runId,
      runRoot: outer,
    });
    mkdirSync(spec.evidenceDirectory, { mode: 0o700 });
    chownSync(spec.evidenceDirectory, spec.uid, spec.gid);
    writeJson(join(spec.evidenceDirectory, "controller-result.json"), {
      schemaVersion: 1,
      passed,
      acceptanceCorpus: spec.corpus === "complete-original-folder",
      cleaned: true,
      removedAllocatedBytes: cleaned.removedAllocatedBytes,
      ...(passed ? result : {}),
    });
  }
  console.log(JSON.stringify({ schemaVersion: 1, passed, cleaned: true }));
}

async function run() {
  assert.equal(process.getuid(), spec.uid);
  assert.equal(
    readFileSync(join(physical(spec.outer), "SENTINEL"), "utf8"),
    `${spec.runId}\n`,
  );
  assert.equal(await digest(spec.candidateArchive), spec.candidateSha256);
  const stageRoot = join(
    physical(spec.mount),
    `run-${spec.runId}-folder-cases`,
  );
  const stageRunId = `${spec.runId}-folder-cases`;
  mkdirSync(stageRoot, { mode: 0o700 });
  writeFileSync(join(stageRoot, "SENTINEL"), `${stageRunId}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    const install = join(stageRoot, "candidate");
    mkdirSync(install, { mode: 0o700 });
    await command("tar", ["-xf", spec.candidateArchive, "-C", install]);
    const packageRoot = join(install, "codefoldersync-0.3.0");
    await command("python3", [
      join(packageRoot, "scripts/install.py"),
      "--install-root",
      join(install, "lib"),
      "--bin-dir",
      join(install, "bin"),
      "--release-sha256",
      spec.candidateSha256,
    ]);
    const module = (name) =>
      import(pathToFileURL(join(packageRoot, "dist/v3", `${name}.js`)).href);
    const { createTreeWitness } = await module("acceptance");
    const { ObjectStore } = await module("objects");
    const fullMaster = physical(spec.restored.masters[0].root);
    assert.ok(fullMaster.startsWith(`${physical(spec.mount)}${sep}`));
    assert.equal(lstatSync(fullMaster).dev, lstatSync(spec.mount).dev);
    assert.equal(lstatSync(fullMaster).mode & 0o222, 0);
    assert.deepEqual(await createTreeWitness(fullMaster), spec.source.witness);
    const template = join(stageRoot, "empty-template");
    const store = new ObjectStore(template);
    store[Symbol.dispose]();
    chmodSync(join(template, "objects.sqlite"), 0o400);
    chmodSync(template, 0o500);
    const results = [];
    for (const caseId of ["impression", "verascient"]) {
      phase = `stress-${caseId}`;
      const masterRoot = physical(join(fullMaster, caseId));
      const masterWitness = await createTreeWitness(masterRoot);
      const runId = `${spec.runId}-${caseId}`;
      const runRoot = join(stageRoot, `run-${caseId}-complete-stress`);
      mkdirSync(runRoot, { mode: 0o700 });
      writeFileSync(join(runRoot, "SENTINEL"), `${runId}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const result = await runFullFolderStress({
        schemaVersion: 1,
        caseId,
        corpus: spec.corpus,
        runId,
        runRoot,
        candidateArchive: spec.candidateArchive,
        candidateSha256: spec.candidateSha256,
        packageRoot,
        command: [join(install, "bin/codefoldersync")],
        masterRoot,
        masterWitness,
        repetitions: 2,
        rounds: spec.corpus === "public-fixture" ? 2 : 24,
        uid: spec.uid,
        seed: `${spec.seed}-${caseId}`,
        nativeFaultLibrary: spec.nativeFaultLibrary,
        evidenceDirectory: join(stageRoot, `${caseId}-stress-evidence`),
        ...(spec.corpus === "complete-original-folder"
          ? {
              originalAcceptanceReceipt: spec.originalAcceptanceReceipt,
              originalFolderWitnessReceipt: spec.originalFolderWitnessReceipt,
              originalSnapshotId: spec.snapshotId,
              originalMachineId: "wootbook",
            }
          : {}),
        storage: {
          kind: "bounded-reflink",
          volumeRunId: spec.runId,
          volumeRunRoot: spec.outer,
          imagePath: spec.image,
          mountRoot: spec.mount,
          maximumImageBytes: spec.maximumImageBytes,
          inheritedMountNamespace: spec.inheritedMountNamespace,
          retainedRoots: spec.retainedRoots,
          objectTemplate: join(template, "objects.sqlite"),
        },
      });
      assert.equal(result.passed, true);
      assert.equal(existsSync(runRoot), false);
      results.push(result);
    }
    assert.deepEqual(await createTreeWitness(fullMaster), spec.source.witness);
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        passed: true,
        acceptanceCorpus: spec.corpus === "complete-original-folder",
        candidateSha256: spec.candidateSha256,
        snapshotId: spec.snapshotId,
        sourceMachineId: "wootbook",
        parentFullTreeVerified: true,
        parentWitness: spec.source.witness,
        unchangedParent: true,
        cases: results,
      }),
    );
  } finally {
    cleanupRunRoot({ schemaVersion: 1, runId: stageRunId, runRoot: stageRoot });
    assert.equal(existsSync(stageRoot), false);
  }
}

try {
  spec = readJson(specPath);
  assert.ok(["controller", "run"].includes(role));
  if (role === "controller") await controller();
  else await run();
} catch (error) {
  const line =
    String(error.stack).match(/run_archived_folder_stress\.mjs:(\d+)/u)?.[1] ??
    "0";
  process.stderr.write(
    `Archived folder stress failed at ${phase} (line ${line}).\n`,
  );
  process.exitCode = 1;
}
