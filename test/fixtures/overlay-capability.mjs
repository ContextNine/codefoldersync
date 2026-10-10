import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run only inside a fresh private mount namespace. This probes the storage
// mechanism with public fixture bytes, not acceptance of an archived corpus.
const [inheritedNamespace, uidText, gidText] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.match(inheritedNamespace ?? "", /^mnt:\[\d+\]$/u);
assert.notEqual(readlinkSync("/proc/self/ns/mnt"), inheritedNamespace);
const uid = Number(uidText);
const gid = Number(gidText);
assert.ok(Number.isSafeInteger(uid) && uid > 0);
assert.ok(Number.isSafeInteger(gid) && gid > 0);

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} failed: ${result.stderr}`);
}

function allocatedBytes(root) {
  const stat = lstatSync(root);
  let bytes = stat.blocks * 512;
  if (stat.isDirectory())
    for (const name of readdirSync(root))
      bytes += allocatedBytes(join(root, name));
  return bytes;
}

const root = mkdtempSync(join(tmpdir(), "codefoldersync-overlay-probe-"));
const sentinel = "private-overlay-capability-v1\n";
const mounted = [];
try {
  writeFileSync(join(root, "SENTINEL"), sentinel, { mode: 0o600 });
  const lower = join(root, "lower");
  const directory = join(lower, "Code", "repo");
  mkdirSync(directory, { recursive: true });
  const payload = Buffer.alloc(2 * 1024 ** 2, 0x61);
  const file = join(directory, "payload.bin");
  writeFileSync(file, payload, { mode: 0o444 });
  symlinkSync("payload.bin", join(directory, "link"));
  symlinkSync("missing", join(directory, "dangling"));
  for (const path of [root, lower, join(lower, "Code"), directory, file])
    chownSync(path, uid, gid);
  for (const path of [lower, join(lower, "Code"), directory])
    chmodSync(path, 0o555);
  const lowerAllocation = allocatedBytes(lower);
  const image = join(root, "full-lower.squashfs");
  const archive = spawnSync("tar", ["-C", lower, "-cf", "-", "."], {
    maxBuffer: 4 * 1024 ** 2,
  });
  assert.equal(archive.status, 0);
  const compressed = spawnSync(
    "mksquashfs",
    [
      "-",
      image,
      "-tar",
      "-comp",
      "zstd",
      "-noappend",
      "-no-progress",
      "-quiet",
      "-processors",
      "2",
    ],
    { input: archive.stdout, encoding: "utf8" },
  );
  assert.equal(compressed.status, 0, compressed.stderr);
  const compressedLower = join(root, "compressed-lower");
  mkdirSync(compressedLower);
  command("mount", ["-t", "squashfs", "-o", "loop,ro", image, compressedLower]);
  mounted.push(compressedLower);
  assert.deepEqual(
    readFileSync(join(compressedLower, "Code/repo/payload.bin")),
    payload,
  );
  const peers = [];
  const upperBeforeWrite = [];
  for (const name of ["peer-a", "peer-b"]) {
    const peer = join(root, name);
    mkdirSync(peer);
    const upper = join(peer, "upper");
    const work = join(peer, "work");
    const view = join(peer, "view");
    for (const path of [peer, upper, work, view]) {
      mkdirSync(path, { recursive: true });
      chownSync(path, uid, gid);
    }
    command("mount", [
      "-t",
      "overlay",
      "overlay",
      "-o",
      `lowerdir=${compressedLower},upperdir=${upper},workdir=${work},metacopy=on`,
      view,
    ]);
    mounted.push(view);
    for (const relative of ["", "Code", "Code/repo"])
      chmodSync(join(view, relative), 0o755);
    chmodSync(join(view, "Code/repo/payload.bin"), 0o644);
    // Metadata-only copy-up must not duplicate the original payload.
    assert.equal(lstatSync(join(upper, "Code/repo/payload.bin")).blocks, 0);
    assert.deepEqual(
      readFileSync(join(view, "Code/repo/payload.bin")),
      payload,
    );
    assert.equal(readlinkSync(join(view, "Code/repo/link")), "payload.bin");
    assert.equal(readlinkSync(join(view, "Code/repo/dangling")), "missing");
    command("setpriv", [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      process.execPath,
      "--input-type=module",
      "-e",
      "import { mkdirSync, writeFileSync } from 'node:fs'; " +
        "import { join } from 'node:path'; " +
        "mkdirSync(join(process.argv[1], 'state')); " +
        "writeFileSync(join(process.argv[1], 'state/recovery'), 'private-state');",
      view,
    ]);
    assert.equal(
      lstatSync(join(view, "Code")).dev,
      lstatSync(join(view, "state")).dev,
    );
    assert.equal(statfsSync(view).type, statfsSync(join(view, "state")).type);
    upperBeforeWrite.push(allocatedBytes(upper));
    peers.push({ upper, view });
  }
  assert.notEqual(lstatSync(peers[0].view).dev, lstatSync(peers[1].view).dev);
  command("setpriv", [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    process.execPath,
    "--input-type=module",
    "-e",
    "import { writeFileSync, unlinkSync } from 'node:fs'; " +
      "writeFileSync(process.argv[1] + '/Code/repo/payload.bin', 'private-edit'); " +
      "unlinkSync(process.argv[1] + '/Code/repo/dangling');",
    peers[0].view,
  ]);
  assert.equal(
    readFileSync(join(peers[0].view, "Code/repo/payload.bin"), "utf8"),
    "private-edit",
  );
  assert.deepEqual(
    readFileSync(join(peers[1].view, "Code/repo/payload.bin")),
    payload,
  );
  assert.deepEqual(readFileSync(file), payload);
  assert.equal(existsSync(join(peers[0].upper, "Code/repo/dangling")), true);
  assert.equal(
    readlinkSync(join(peers[1].view, "Code/repo/dangling")),
    "missing",
  );
  assert.equal(readlinkSync(join(directory, "dangling")), "missing");
  assert.equal(lstatSync(file).mode & 0o777, 0o444);
  assert.equal(allocatedBytes(lower), lowerAllocation);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      privateNamespace: true,
      independentFullViews: true,
      unchangedLower: true,
      sameFilesystemState: true,
      unprivilegedWrites: true,
      metadataOnlyCopyUp: true,
      compressedReadOnlyLower: true,
      compressedLowerAllocatedBytes: lstatSync(image).blocks * 512,
      lowerAllocatedBytes: lowerAllocation,
      upperAllocatedBytesBeforeWrites: upperBeforeWrite,
      upperAllocatedBytesAfterWrites: peers.map(({ upper }) =>
        allocatedBytes(upper),
      ),
      acceptanceCorpus: false,
    }) + "\n",
  );
} finally {
  for (const view of mounted.reverse()) command("umount", [view]);
  assert.equal(readFileSync(join(root, "SENTINEL"), "utf8"), sentinel);
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  for (const path of [
    join(root, "lower"),
    join(root, "lower/Code"),
    join(root, "lower/Code/repo"),
  ])
    if (existsSync(path)) chmodSync(path, 0o755);
  rmSync(root, { recursive: true });
}
