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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ObjectStore } from "../../dist/v3/objects.js";

const [inheritedNamespace, uidText, gidText] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.match(inheritedNamespace ?? "", /^mnt:\[\d+\]$/u);
assert.notEqual(readlinkSync("/proc/self/ns/mnt"), inheritedNamespace);
const uid = Number(uidText);
const gid = Number(gidText);
assert.ok(Number.isSafeInteger(uid) && uid > 0);
assert.ok(Number.isSafeInteger(gid) && gid > 0);
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

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
try {
  writeFileSync(join(root, "SENTINEL"), sentinel, { mode: 0o600 });
  const image = join(root, "fresh-filesystem.img");
  const fd = openSync(image, "wx", 0o600);
  ftruncateSync(fd, 256 * 1024 ** 2);
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
      acceptanceCorpus: false,
    }) + "\n",
  );
} finally {
  if (mounted) command("umount", [mountpoint]);
  assert.equal(readFileSync(join(root, "SENTINEL"), "utf8"), sentinel);
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  rmSync(root, { recursive: true });
}
