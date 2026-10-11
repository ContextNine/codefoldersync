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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFullFolderStress } from "../../scripts/run_full_folder_stress.mjs";

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
  assert.equal(result.status, 0, "Public mechanics command failed");
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
const { ObjectStore } = await module("objects");
const { cleanupRunRoot } = await module("storage");
try {
  command("python3", [
    join(packageRoot, "scripts/install.py"),
    "--install-root",
    join(root, "lib"),
    "--bin-dir",
    join(root, "bin"),
    "--release-sha256",
    control.candidateSha256,
  ]);
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
  const template = join(root, "object-template");
  const emptyTemplate = new ObjectStore(template);
  emptyTemplate[Symbol.dispose]();
  protect(template);
  const results = [];
  for (const caseId of ["impression", "verascient"]) {
    const runRoot = join(root, `run-${caseId}`);
    const caseRunId = `public-full-${caseId}-stress`;
    mkdirSync(runRoot, { mode: 0o700 });
    writeFileSync(join(runRoot, "SENTINEL"), `${caseRunId}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const result = await runFullFolderStress({
      schemaVersion: 1,
      caseId,
      corpus: "public-fixture",
      runId: caseRunId,
      runRoot,
      candidateArchive: control.candidateArchive,
      candidateSha256: control.candidateSha256,
      packageRoot,
      command: [join(root, "bin/codefoldersync")],
      masterRoot: master,
      masterWitness,
      repetitions: 2,
      rounds: 2,
      uid: control.uid,
      seed: `public-${caseId}-mechanics`,
      evidenceDirectory: join(root, `${caseId}-evidence`),
      nativeFaultLibrary: control.nativeFaultLibrary,
      storage: {
        kind: "bounded-reflink",
        volumeRunId: control.runId,
        volumeRunRoot: control.outer,
        imagePath: control.image,
        mountRoot: control.mount,
        maximumImageBytes: control.maximumImageBytes,
        inheritedMountNamespace: control.inheritedMountNamespace,
        retainedRoots: control.retainedRoots,
        objectTemplate: join(template, "objects.sqlite"),
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.acceptanceCorpus, false);
    assert.equal(existsSync(runRoot), false);
    results.push({
      caseId,
      passed: true,
      repetitions: result.results.length,
      acceptanceCorpus: false,
    });
  }
  assert.deepEqual(await createTreeWitness(master), masterWitness);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      publicDriverMechanics: results,
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
