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
  readdirSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../dist/v2/hash.js";
import { distributedAgentFailureDetail } from "../dist/v3/distributed-process.js";
import {
  inspectPhysicalTree,
  storageLimits,
  cleanupRunRoot,
} from "../dist/v3/storage.js";

// This controller is not a current-format restore API. It verifies complete
// historical archive witnesses without manufacturing a semantic manifest.
const [role, specPath] = process.argv.slice(2);
let spec;
try {
  spec = JSON.parse(readFileSync(physical(specPath), "utf8"));
} catch {
  process.stderr.write("Private controller specification is invalid.\n");
  process.exit(1);
}
const script = fileURLToPath(import.meta.url);
const children = new Set();
const workers = new Set();
let interrupted = false;
let step = role;
const failurePrefix = "CFS_ARCHIVE_FAILURE ";
const failureCodes = new Set([
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ERR_ASSERTION",
  "command-failed",
  "distributed-agent-failed",
  "unknown",
]);

// Retain only enums and source locations, never messages, paths, or stderr.
function failureRecord(error) {
  if (error?.cause?.archiveFailure) return error.cause.archiveFailure;
  const location = String(error?.stack).match(
    /\/(?:dist\/v[23]\/|scripts\/)([a-z0-9_-]+\.(?:mjs|js)):(\d+):\d+/u,
  );
  return {
    phase: step,
    code: failureCodes.has(error?.code) ? error.code : "unknown",
    ...distributedAgentFailureDetail(error),
    ...(location ? { module: location[1], line: Number(location[2]) } : {}),
  };
}

function readFailure(line) {
  if (!line.startsWith(failurePrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(failurePrefix.length));
    if (
      !/^(?:preflight|candidate-install|seed-template|run-acceptance|volume-create|volume-grow|finalize|(?:download|restore|witness)-(?:mattbook|wootbook|workermacair))$/u.test(
        value.phase,
      ) ||
      !failureCodes.has(value.code)
    )
      return undefined;
    return {
      phase: value.phase,
      code: value.code,
      ...distributedAgentFailureDetail(value),
      ...(typeof value.module === "string" &&
      /^[a-z0-9_-]+\.(?:mjs|js)$/u.test(value.module) &&
      Number.isSafeInteger(value.line) &&
      value.line >= 0
        ? { module: value.module, line: value.line }
        : {}),
    };
  } catch {
    return undefined;
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    // Drain managed commands before cleanup. The protected credential broker
    // can launch its command outside this client's process group/namespace.
    if (role === "controller")
      for (const worker of workers) worker.kill(signal);
  });

function physical(path) {
  assert.ok(
    typeof path === "string" && isAbsolute(path) && resolve(path) === path,
  );
  assert.equal(realpathSync(path), path);
  assert.ok(!lstatSync(path).isSymbolicLink());
  return path;
}

async function command(program, args, options = {}) {
  if (interrupted) throw new Error("Controller interrupted");
  const { worker = false, ...spawnOptions } = options;
  const child = spawn(program, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnOptions,
  });
  children.add(child);
  if (worker) workers.add(child);
  const chunks = [];
  let bytes = 0;
  let excessive = false;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 1024 ** 2) chunks.push(chunk);
    else excessive = true;
  });
  // Never publish command diagnostics, which can contain paths or values.
  let childFailure;
  let pendingDiagnostic = "";
  child.stderr.on("data", (chunk) => {
    pendingDiagnostic += chunk.toString("utf8");
    if (pendingDiagnostic.length > 8192) pendingDiagnostic = "";
    const lines = pendingDiagnostic.split("\n");
    pendingDiagnostic = lines.pop() ?? "";
    for (const line of lines) childFailure = readFailure(line) ?? childFailure;
  });
  try {
    const outcome = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => done({ status, signal }));
    });
    if (outcome.status !== 0)
      throw new Error("Controller command failed", {
        cause: {
          archiveFailure: {
            ...(childFailure ?? { phase: step, code: "command-failed" }),
            exitCode: outcome.status,
            signal: outcome.signal,
          },
        },
      });
    assert.equal(
      excessive,
      false,
      "Controller command output exceeded its bound",
    );
    if (interrupted) throw new Error("Controller interrupted");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    children.delete(child);
    workers.delete(child);
  }
}

function owner(path) {
  chownSync(path, spec.uid, spec.gid);
}
function writePrivate(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  owner(path);
}
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function validateInput() {
  assert.equal(spec.schemaVersion, 1);
  assert.match(spec.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u);
  assert.match(spec.snapshotId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  assert.ok(Number.isSafeInteger(spec.uid) && spec.uid > 0);
  assert.ok(Number.isSafeInteger(spec.gid) && spec.gid > 0);
  assert.match(spec.inheritedMountNamespace, /^mnt:\[\d+\]$/u);
  assert.notEqual(
    readlinkSync("/proc/self/ns/mnt"),
    spec.inheritedMountNamespace,
  );
  assert.ok(Array.isArray(spec.sources) && spec.sources.length === 3);
  assert.deepEqual([...spec.sources.map((source) => source.machineId)].sort(), [
    "mattbook",
    "wootbook",
    "workermacair",
  ]);
  for (const source of spec.sources) {
    assert.match(
      source.archiveName,
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst\.age$/u,
    );
    assert.match(source.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
    assert.equal(source.recoveryVerified, true);
    assert.equal(source.remoteDownloadedContentVerified, true);
    assert.equal(source.witness.schemaVersion, 1);
    assert.match(source.witness.digest, /^[a-f0-9]{64}$/u);
  }
  const identity = lstatSync(physical(spec.identityPath));
  assert.ok(identity.isFile() && (identity.mode & 0o077) === 0);
  assert.equal(identity.uid, spec.uid);
  assert.ok(
    Array.isArray(spec.downloadCommand) && spec.downloadCommand.length > 0,
  );
  for (const argument of spec.downloadCommand)
    assert.equal(typeof argument, "string");
  physical(spec.downloadCommand[0]);
  assert.match(spec.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.ok(spec.nativeFaultLibrary);
  const faultLibrary = lstatSync(physical(spec.nativeFaultLibrary.path));
  assert.ok(faultLibrary.isFile() && (faultLibrary.mode & 0o222) === 0);
  assert.match(spec.nativeFaultLibrary.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(spec.nativeFaultLibrary.path))
      .digest("hex"),
    spec.nativeFaultLibrary.sha256,
  );
  assert.ok(lstatSync(physical(spec.candidateArchive)).isFile());
  assert.ok(Array.isArray(spec.retainedRoots) && spec.retainedRoots.length > 0);
  const roots = spec.retainedRoots.map(physical);
  assert.ok(
    ![...roots, spec.runParent, spec.evidenceDirectory].some((path) =>
      path.split(sep).includes("Code"),
    ),
  );
  assert.notEqual(spec.runParent, sep);
  for (const [index, root] of roots.entries())
    assert.ok(
      !roots.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (other === root || root.startsWith(`${other}${sep}`)),
      ),
    );
  physical(spec.runParent);
  assert.ok(
    !roots.some(
      (root) =>
        spec.runParent === root || spec.runParent.startsWith(`${root}${sep}`),
    ),
  );
  assert.ok(["original-code-archive", "public-fixture"].includes(spec.corpus));
  assert.ok(
    Number.isSafeInteger(spec.allocationLimitBytes) &&
      spec.allocationLimitBytes <= storageLimits.wootbookHardBytes &&
      spec.allocationLimitBytes >= 512 * 1024 ** 2,
  );
  assert.equal(existsSync(spec.evidenceDirectory), false);
  physical(dirname(spec.evidenceDirectory));
}

async function unprivileged(stage, controlPath) {
  return JSON.parse(
    await command(
      "setpriv",
      [
        `--reuid=${spec.uid}`,
        `--regid=${spec.gid}`,
        "--clear-groups",
        process.execPath,
        script,
        stage,
        controlPath,
      ],
      { worker: true },
    ),
  );
}

async function controller() {
  step = "preflight";
  assert.equal(process.getuid(), 0);
  validateInput();
  assert.equal(await digest(spec.candidateArchive), spec.candidateSha256);
  const retainedBytes = spec.retainedRoots.reduce(
    (total, root) => total + inspectPhysicalTree(root).allocatedBytes,
    0,
  );
  const reserve = 64 * 1024 ** 2;
  const downloadReserve =
    Math.max(...spec.sources.map((source) => source.bytes)) + reserve;
  const finalMaximum =
    Math.floor((spec.allocationLimitBytes - retainedBytes - reserve) / 4096) *
    4096;
  const restoreMaximum =
    finalMaximum - Math.ceil(downloadReserve / 4096) * 4096;
  assert.ok(
    restoreMaximum >= 256 * 1024 ** 2,
    "Complete archive recovery cannot fit its bounded slot",
  );
  const filesystem = statfsSync(spec.runParent);
  assert.ok(
    filesystem.bavail * filesystem.bsize >= finalMaximum + downloadReserve,
  );
  const outer = mkdtempSync(join(spec.runParent, `run-${spec.runId}-`));
  owner(outer);
  const image = join(outer, "acceptance.img");
  const mount = join(outer, "filesystem");
  let mounted = false;
  let passed = false;
  let report;
  let restored;
  let failure;
  let storageAtFailure;
  let filesystemMetadataProfile;
  try {
    step = "volume-create";
    writeFileSync(join(outer, "SENTINEL"), `${spec.runId}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    owner(join(outer, "SENTINEL"));
    const descriptor = openSync(image, "wx", 0o600);
    try {
      ftruncateSync(descriptor, restoreMaximum);
    } finally {
      closeSync(descriptor);
    }
    assert.ok(lstatSync(image).isFile() && lstatSync(image).nlink === 1);
    // Original ciphertext stays outside this disposable, checksum-verified volume.
    await command("mkfs.btrfs", ["--nodiscard", "--metadata", "single", image]);
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
    const layout = await command("btrfs", ["filesystem", "df", "--raw", mount]);
    filesystemMetadataProfile = layout.match(/^Metadata, (\w+):/mu)?.[1];
    assert.equal(filesystemMetadataProfile, "single");
    owner(mount);
    const control = {
      ...spec,
      outer,
      image,
      mount,
      restoreMaximum,
      finalMaximum,
      retainedBytes,
    };
    const restoreControl = join(outer, "restore-control.json");
    writePrivate(restoreControl, control);
    restored = await unprivileged("restore", restoreControl);
    assert.equal(restored.passed, true);
    step = "volume-grow";
    // Grow only after every external download was removed, before product runs.
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
    const growth = openSync(image, "r+");
    try {
      ftruncateSync(growth, finalMaximum);
    } finally {
      closeSync(growth);
    }
    await command("losetup", ["--set-capacity", device]);
    await command("btrfs", ["filesystem", "resize", "max", mount]);
    const runControl = join(outer, "run-control.json");
    writePrivate(runControl, { ...control, restored });
    step = "run-acceptance";
    report = await unprivileged("run", runControl);
    assert.equal(report.passed, true);
    step = "finalize";
    await command("sync", ["-f", mount]);
    await command("fstrim", [mount]);
    report.imageAllocatedBytes = lstatSync(image).blocks * 512;
    report.maximumTotalBytes = retainedBytes + finalMaximum + reserve;
    assert.ok(report.maximumTotalBytes <= storageLimits.wootbookHardBytes);
    passed = true;
  } catch (error) {
    failure = failureRecord(error);
    if (mounted) {
      const filesystem = statfsSync(mount);
      storageAtFailure = {
        availableBytes: filesystem.bavail * filesystem.bsize,
        filesystemBytes: filesystem.blocks * filesystem.bsize,
        imageAllocatedBytes: lstatSync(image).blocks * 512,
        maximumImageBytes: finalMaximum,
        retainedAllocatedBytes: retainedBytes,
      };
    }
    throw error;
  } finally {
    assert.equal(children.size, 0, "Controller still has active children");
    // Cleanup commands must still run after a deferred interrupt.
    interrupted = false;
    if (mounted) await command("umount", [mount]);
    const cleaned = cleanupRunRoot({
      schemaVersion: 1,
      runId: spec.runId,
      runRoot: outer,
    });
    mkdirSync(spec.evidenceDirectory, { mode: 0o700 });
    owner(spec.evidenceDirectory);
    writePrivate(join(spec.evidenceDirectory, "controller-result.json"), {
      schemaVersion: 1,
      runId: spec.runId,
      acceptanceCorpus: spec.corpus === "original-code-archive",
      candidateSha256: spec.candidateSha256,
      filesystemMetadataProfile,
      passed,
      cleaned: true,
      removedAllocatedBytes: cleaned.removedAllocatedBytes,
      ...(restored
        ? {
            historicalFormat: true,
            historicalTrees: restored.masters.map(({ machineId, witness }) => ({
              machineId,
              witness,
            })),
          }
        : {}),
      ...(failure ? { failure, storageAtFailure } : {}),
      ...(passed ? report : {}),
    });
  }
  emit({ schemaVersion: 1, passed, cleaned: true });
}

async function restore() {
  assert.equal(process.getuid(), spec.uid);
  assert.equal(
    readFileSync(join(spec.outer, "SENTINEL"), "utf8"),
    `${spec.runId}\n`,
  );
  assert.notEqual(lstatSync(spec.mount).dev, lstatSync(spec.outer).dev);
  const { createTreeWitness } = await import("../dist/v3/acceptance.js");
  const restored = [];
  for (const source of spec.sources) {
    step = `download-${source.machineId}`;
    const slot = join(spec.outer, `download-${source.machineId}`);
    const slotId = `${spec.runId}-${source.machineId}`;
    mkdirSync(slot, { mode: 0o700 });
    writeFileSync(join(slot, "SENTINEL"), `${slotId}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      const bundle = join(slot, "bundle");
      const transfer = JSON.parse(
        await command(spec.downloadCommand[0], [
          ...spec.downloadCommand.slice(1),
          "download",
          "--machine-id",
          "wootbook",
          "--source-machine-id",
          source.machineId,
          "--snapshot-id",
          spec.snapshotId,
          "--destination",
          bundle,
          "--approve",
        ]),
      );
      assert.equal(transfer.verified, true);
      assert.ok(
        inspectPhysicalTree(slot).allocatedBytes <=
          source.bytes + 64 * 1024 ** 2,
      );
      const witness = JSON.parse(
        readFileSync(join(bundle, "witness.json"), "utf8"),
      );
      assert.equal(witness.snapshot_id, spec.snapshotId);
      assert.equal(witness.machine_id, source.machineId);
      assert.equal(witness.artifacts.length, 1);
      assert.deepEqual(witness.artifacts[0], {
        name: source.archiveName,
        size: source.bytes,
        sha256: source.sha256,
      });
      assert.deepEqual(
        readdirSync(bundle).sort(),
        [source.archiveName, "witness.json"].sort(),
      );
      const archive = physical(join(bundle, source.archiveName));
      assert.equal(lstatSync(archive).size, source.bytes);
      assert.equal(await digest(archive), source.sha256);
      const destination = join(spec.mount, "masters", source.machineId);
      step = `restore-${source.machineId}`;
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      await extract(archive, destination, source.machineId === "wootbook");
      if (interrupted) throw new Error("Controller interrupted");
      assert.deepEqual(readdirSync(destination), ["Code"]);
      const code = physical(join(destination, "Code"));
      protect(code, lstatSync(spec.mount).dev);
      const actual = await createTreeWitness(code);
      step = `witness-${source.machineId}`;
      assert.equal(
        canonicalJson(actual),
        canonicalJson(source.witness),
        "Historical full tree witness mismatch",
      );
      restored.push({
        machineId: source.machineId,
        root: code,
        witness: actual,
      });
    } finally {
      cleanupRunRoot({ schemaVersion: 1, runId: slotId, runRoot: slot });
    }
  }
  emit({ passed: true, historicalFormat: true, masters: restored });
}

async function extract(archive, destination, linux) {
  // Native tar rejects traversal and symlink-parent extraction. Its output is
  // never returned. Permit only the known BSD metadata-key warnings.
  const age = spawn(
    "age",
    ["--decrypt", "--identity", spec.identityPath, archive],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const zstd = spawn("zstd", ["--decompress", "--stdout", "--quiet"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const tar = spawn(
    "tar",
    [
      "--extract",
      "--file=-",
      `--directory=${destination}`,
      "--no-same-owner",
      "--same-permissions",
      "--delay-directory-restore",
      ...(linux ? ["--acls", "--xattrs"] : []),
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  );
  const pipelines = [age, zstd, tar];
  const statusesPromise = Promise.all(
    pipelines.map(
      (child) =>
        new Promise((done) => {
          child.once("error", () => {
            for (const other of pipelines)
              if (other !== child) other.kill("SIGTERM");
            done(-1);
          });
          child.once("close", done);
        }),
    ),
  );
  age.stdout.pipe(zstd.stdin);
  zstd.stdout.pipe(tar.stdin);
  for (const stream of [age.stdout, zstd.stdin, zstd.stdout, tar.stdin])
    stream.on("error", () => {});
  let unexpected = false;
  let pending = "";
  for (const child of [age, zstd])
    child.stderr.on("data", () => {
      unexpected = true;
    });
  const accept = (line) => {
    if (
      line &&
      (linux ||
        !/^tar: Ignoring unknown extended header keyword '(?:LIBARCHIVE\.(?:creationtime|xattr\.[^'\r\n]+)|SCHILY\.(?:fflags|acl\.[^'\r\n]+))'$/u.test(
          line,
        ))
    )
      unexpected = true;
  };
  tar.stderr.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 1024 ** 2) {
      unexpected = true;
      pending = "";
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) accept(line);
  });
  const statuses = await statusesPromise;
  accept(pending);
  assert.ok(
    statuses.every((status) => status === 0) && !unexpected,
    "Historical restore pipeline failed",
  );
}

function protect(path, device) {
  const stat = lstatSync(path);
  assert.equal(stat.dev, device);
  if (stat.isSymbolicLink()) return;
  assert.ok(stat.isFile() || stat.isDirectory());
  if (stat.isDirectory())
    for (const name of readdirSync(path)) protect(join(path, name), device);
  chmodSync(path, stat.mode & ~0o222);
}

async function run() {
  step = "candidate-install";
  assert.equal(process.getuid(), spec.uid);
  const install = join(spec.mount, "candidate");
  mkdirSync(install, { mode: 0o700 });
  assert.equal(await digest(spec.candidateArchive), spec.candidateSha256);
  await command("tar", [
    "--extract",
    "--file",
    spec.candidateArchive,
    "--directory",
    install,
  ]);
  const packageRoot = join(install, "codefoldersync-0.3.0");
  await command("python3", [
    join(packageRoot, "scripts/install.py"),
    "--install-root",
    join(spec.mount, "tools"),
    "--bin-dir",
    join(spec.mount, "bin"),
    "--release-sha256",
    spec.candidateSha256,
  ]);
  const module = (name) =>
    import(pathToFileURL(join(packageRoot, "dist/v3", `${name}.js`)).href);
  const { seedAcceptanceObjectTemplate } = await module("acceptance-reflink");
  const { runPseudoFleetAcceptanceV3 } = await module("acceptance");
  const template = join(spec.mount, "object-template");
  step = "seed-template";
  const seed = seedAcceptanceObjectTemplate(
    spec.restored.masters.map((master) => master.root),
    template,
  );
  const runRoot = join(spec.mount, "run-archived-pseudo-fleet");
  mkdirSync(runRoot, { mode: 0o700 });
  writeFileSync(join(runRoot, "SENTINEL"), `${spec.runId}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  step = "run-acceptance";
  const results = await runPseudoFleetAcceptanceV3({
    schemaVersion: 1,
    runId: spec.runId,
    scenarioId: "complete-code-archive",
    seed: spec.seed,
    repetitions: 2,
    runRoot,
    evidenceDirectory: join(spec.mount, "private-run-evidence"),
    expectedVersion: "0.3.0",
    expectedReleaseSha256: spec.candidateSha256,
    command: [join(spec.mount, "bin/codefoldersync")],
    backupWitness: spec.snapshotId,
    sourceMachineId: "mattbook",
    targetOrder: ["wootbook", "workermacair"],
    hubMachineId: "wootbook",
    masters: spec.restored.masters,
    nativeFaultLibrary: spec.nativeFaultLibrary,
    storage: {
      kind: "bounded-reflink",
      volumeRunId: spec.runId,
      volumeRunRoot: spec.outer,
      imagePath: spec.image,
      mountRoot: spec.mount,
      maximumImageBytes: spec.finalMaximum,
      inheritedMountNamespace: spec.inheritedMountNamespace,
      retainedRoots: spec.retainedRoots,
      objectTemplate: join(template, "objects.sqlite"),
    },
  });
  emit({
    schemaVersion: 1,
    passed: true,
    historicalFormat: true,
    candidateSha256: spec.candidateSha256,
    historicalTrees: spec.restored.masters.map(({ machineId, witness }) => ({
      machineId,
      witness,
    })),
    seed,
    repetitions: results,
  });
}

try {
  assert.ok(["controller", "restore", "run"].includes(role));
  if (role === "controller") await controller();
  else if (role === "restore") await restore();
  else await run();
} catch (error) {
  process.stderr.write(
    `${failurePrefix}${JSON.stringify(failureRecord(error))}\n`,
  );
  process.exitCode = 1;
}
