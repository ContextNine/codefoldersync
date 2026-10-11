import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const control = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(process.getuid(), control.uid);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Public fixture",
  GIT_COMMITTER_NAME: "Public fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
Object.assign(process.env, env);
const command = (program, args) => {
  const result = spawnSync(program, args, { env, encoding: "utf8" });
  const coarse =
    result.stderr?.match(
      /Archived folder stress failed at [a-z0-9-]+ \(line \d+\)\./u,
    )?.[0] ?? "";
  assert.equal(result.status, 0, `Public mechanics command failed. ${coarse}`);
  return result.stdout;
};
assert.equal(
  createHash("sha256")
    .update(readFileSync(control.candidateArchive))
    .digest("hex"),
  control.candidateSha256,
);
const root = mkdtempSync(join(control.mount, "run-stress-mechanics-"));
const runId = "full-folder-stress-mechanics";
writeFileSync(join(root, "SENTINEL"), `${runId}\n`, {
  mode: 0o600,
  flag: "wx",
});
command("tar", ["-xf", control.candidateArchive, "-C", root]);
const packageRoot = join(root, "codefoldersync-0.3.0");
const module = (name) =>
  import(pathToFileURL(join(packageRoot, "dist/v3", `${name}.js`)).href);
const { createTreeWitness } = await module("acceptance");
const { cleanupRunRoot } = await module("storage");
try {
  const master = join(root, "master");
  mkdirSync(master, { mode: 0o700 });
  writeFileSync(join(master, "tracked.ts"), "export const fixture = true;\n");
  for (const args of [
    ["init", "-b", "master"],
    ["add", "tracked.ts"],
    ["commit", "-m", "fixture"],
  ])
    command("git", [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      master,
      ...args,
    ]);
  command("git", [
    "-C",
    master,
    "config",
    "filter.stress-risky.clean",
    "false",
  ]);
  command("git", [
    "-C",
    master,
    "config",
    "filter.stress-risky.required",
    "true",
  ]);
  writeFileSync(join(master, ".gitattributes"), "*.txt filter=stress-risky\n");
  writeFileSync(
    join(master, ".git/hooks/reference-transaction"),
    "#!/bin/sh\nexit 91\n",
    { mode: 0o755 },
  );
  writeFileSync(
    join(master, ".env"),
    "FIXTURE_ONLY=public-fixture-not-a-secret\n",
    { mode: 0o600 },
  );
  mkdirSync(join(master, "node_modules/example"), { recursive: true });
  writeFileSync(
    join(master, "node_modules/local.txt"),
    "ignored public fixture\n",
  );
  writeFileSync(
    join(master, "node_modules/example/.git"),
    "not a git indirection fixture\n",
  );
  const protect = (path) => {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) protect(join(path, entry));
    chmodSync(path, stat.mode & ~0o222);
  };
  protect(master);
  const masterWitness = await createTreeWitness(master);
  const fullParent = join(root, "controller-master/Code");
  mkdirSync(fullParent, { recursive: true, mode: 0o700 });
  for (const caseId of ["impression", "verascient"]) {
    command("cp", ["-a", "--reflink=always", master, join(fullParent, caseId)]);
  }
  protect(fullParent);
  const parentWitness = await createTreeWitness(fullParent);
  const ciphertexts = join(root, "controller-ciphertexts");
  mkdirSync(ciphertexts, { mode: 0o700 });
  writeFileSync(
    join(ciphertexts, "SENTINEL"),
    "public-archived-controller-fixture\n",
    { mode: 0o600 },
  );
  const identityPath = join(ciphertexts, "fixture.agekey");
  command("age-keygen", ["--output", identityPath]);
  const recipient = command("age-keygen", ["--y", identityPath]).trim();
  const bundle = join(ciphertexts, "wootbook");
  mkdirSync(bundle, { mode: 0o700 });
  const archiveName = "wootbook-code.tar.zst.age";
  const archive = join(bundle, archiveName);
  command("bash", [
    "-o",
    "pipefail",
    "-c",
    'tar -cf - -C "$1" Code | zstd --quiet --stdout | age --recipient "$2" --output "$3"',
    "public-fixture",
    join(root, "controller-master"),
    recipient,
    archive,
  ]);
  const archiveSha256 = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const archiveBytes = lstatSync(archive).size;
  const snapshotId = "public-controller-snapshot";
  writeFileSync(
    join(bundle, "witness.json"),
    JSON.stringify({
      schema_version: 1,
      snapshot_id: snapshotId,
      machine_id: "wootbook",
      artifacts: [
        { name: archiveName, size: archiveBytes, sha256: archiveSha256 },
      ],
    }),
    { mode: 0o600 },
  );
  const restoreScript = new URL(
    "../../scripts/run_bounded_archived_acceptance.mjs",
    import.meta.url,
  ).pathname;
  const folderController = new URL(
    "../../scripts/run_archived_folder_stress.mjs",
    import.meta.url,
  ).pathname;
  const controllerControl = join(root, "controller-run.json");
  const controllerEvidence = join(root, "controller-evidence");
  const controllerVolumes = () =>
    readdirSync(control.mount)
      .filter((name) =>
        /^run-public-controller-(?:fixture|failure)-/u.test(name),
      )
      .sort();
  const previousVolumes = controllerVolumes();
  writeFileSync(
    controllerControl,
    JSON.stringify({
      schemaVersion: 1,
      corpus: "public-fixture",
      runId: "public-controller-fixture",
      snapshotId,
      seed: "public-controller-mechanics",
      uid: control.uid,
      gid: process.getgid(),
      inheritedMountNamespace: readlinkSync("/proc/self/ns/mnt"),
      source: {
        machineId: "wootbook",
        witness: parentWitness,
        archiveName,
        bytes: archiveBytes,
        sha256: archiveSha256,
        recoveryVerified: true,
        remoteDownloadedContentVerified: true,
      },
      candidateArchive: control.candidateArchive,
      candidateSha256: control.candidateSha256,
      nativeFaultLibrary: control.nativeFaultLibrary,
      identityPath,
      maximumImageBytes: 512 * 1024 ** 2,
      runParent: control.mount,
      retainedRoots: [root],
      evidenceDirectory: controllerEvidence,
      restoreScript,
      restoreScriptSha256: createHash("sha256")
        .update(readFileSync(restoreScript))
        .digest("hex"),
      downloadCommand: [
        process.execPath,
        new URL("copy-download.mjs", import.meta.url).pathname,
        ciphertexts,
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
  const completion = JSON.parse(
    command(realpathSync("/usr/bin/sudo"), [
      "-n",
      "unshare",
      "--mount",
      "--fork",
      "--propagation",
      "private",
      process.execPath,
      folderController,
      "controller",
      controllerControl,
    ]),
  );
  assert.equal(completion.passed, true);
  assert.equal(completion.cleaned, true);
  const result = JSON.parse(
    readFileSync(join(controllerEvidence, "controller-result.json"), "utf8"),
  );
  assert.equal(result.passed, true);
  assert.equal(result.acceptanceCorpus, false);
  assert.equal(result.unchangedParent, true);
  assert.deepEqual(result.parentWitness, parentWitness);
  assert.deepEqual(await createTreeWitness(fullParent), parentWitness);
  assert.equal(result.cleaned, true);
  assert.deepEqual(controllerVolumes(), previousVolumes);
  const failureSpec = join(root, "controller-failure.json");
  const failureEvidence = join(root, "controller-failure-evidence");
  const acceptedSpec = JSON.parse(readFileSync(controllerControl, "utf8"));
  writeFileSync(
    failureSpec,
    JSON.stringify({
      ...acceptedSpec,
      runId: "public-controller-failure",
      evidenceDirectory: failureEvidence,
      downloadCommand: [...acceptedSpec.downloadCommand, "--corrupt-download"],
    }),
    { mode: 0o600, flag: "wx" },
  );
  const rejected = spawnSync(
    realpathSync("/usr/bin/sudo"),
    [
      "-n",
      "unshare",
      "--mount",
      "--fork",
      "--propagation",
      "private",
      process.execPath,
      folderController,
      "controller",
      failureSpec,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(rejected.status, 1);
  const rejectedResult = JSON.parse(
    readFileSync(join(failureEvidence, "controller-result.json"), "utf8"),
  );
  assert.equal(rejectedResult.passed, false);
  assert.equal(rejectedResult.cleaned, true);
  assert.deepEqual(controllerVolumes(), previousVolumes);
  assert.equal(
    createHash("sha256").update(readFileSync(archive)).digest("hex"),
    archiveSha256,
  );
  const results = [];
  for (const caseResult of result.cases) {
    assert.equal(caseResult.passed, true);
    assert.equal(caseResult.acceptanceCorpus, false);
    results.push({
      caseId: caseResult.caseId,
      passed: true,
      repetitions: caseResult.results.length,
      acceptanceCorpus: false,
    });
  }
  assert.deepEqual(await createTreeWitness(master), masterWitness);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      publicDriverMechanics: results,
      completeParentController: true,
      completeParentWitnessMatched: true,
      exactControllerStageCleanup: true,
      fullControllerLifecycle: true,
      originalFixtureCiphertextUnchanged: true,
      corruptedDownloadRejectedAndCleaned: true,
      unchangedMaster: true,
      ignoredInvalidGitMarkerRetained: true,
      unsafeGitHooksAndFiltersNotInvoked: true,
      capacityCertificate: false,
      originalArchiveAcceptance: false,
    }),
  );
} finally {
  cleanupRunRoot({ schemaVersion: 1, runId, runRoot: root });
  assert.equal(existsSync(root), false);
}
