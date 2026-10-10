import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { capturePath, ObjectStore } from "./objects.js";
import { compileIgnore, defaultIgnore } from "./ignore.js";
import { defaultSyncPolicy, policyIncludes } from "./policy.js";
import type { SyncPolicy } from "./types.js";
import {
  inspectPhysicalTree,
  storageLimits,
  validateCleanupRunRoot,
} from "./storage.js";

/** The controller owns the mount lifecycle; the product never mounts a volume. */
export interface BoundedReflinkStorage {
  readonly kind: "bounded-reflink";
  readonly volumeRunId: string;
  readonly volumeRunRoot: string;
  readonly imagePath: string;
  readonly mountRoot: string;
  readonly maximumImageBytes: number;
  readonly inheritedMountNamespace: string;
  readonly retainedRoots: readonly string[];
  readonly objectTemplate: string;
}

export interface BoundedReflinkBudget {
  readonly retainedAllocatedBytes: number;
  readonly imageAllocatedBytes: number;
  readonly maximumImageBytes: number;
  readonly controlReserveBytes: number;
  readonly maximumTotalBytes: number;
  readonly aboveNormalTarget: boolean;
  readonly passed: true;
}

const controlReserveBytes = 64 * 1024 ** 2;

/** Seed content only, committing bounded buffers instead of a corpus-sized WAL. */
export function seedAcceptanceObjectTemplate(
  roots: readonly string[],
  directory: string,
  policy: SyncPolicy = defaultSyncPolicy,
): {
  readonly objects: number;
  readonly objectBytes: number;
  readonly capturedLeaves: number;
} {
  if (existsSync(directory))
    throw new Error("Acceptance template destination exists");
  physical(dirname(directory));
  const devices = roots.map((root) => {
    const stat = lstatSync(physical(root));
    if (!stat.isDirectory() || (stat.mode & 0o222) !== 0)
      throw new Error("Acceptance template requires protected masters");
    return stat.dev;
  });
  if (
    devices.length < 3 ||
    devices.some((device) => device !== lstatSync(dirname(directory)).dev)
  )
    throw new Error(
      "Acceptance template and complete masters must share a filesystem",
    );
  class BufferedStore extends ObjectStore {
    readonly seen = new Set<string>();
    readonly pending = new Map<string, Buffer>();
    objectBytes = 0;
    private pendingBytes = 0;

    public override put(
      bytes: Buffer,
      expectedId = createHash("sha256").update(bytes).digest("hex"),
    ): string {
      if (createHash("sha256").update(bytes).digest("hex") !== expectedId)
        throw new Error("Acceptance seed object digest mismatch");
      if (this.seen.has(expectedId)) return expectedId;
      this.seen.add(expectedId);
      // The product chunker reuses its buffer after this synchronous call.
      this.pending.set(expectedId, Buffer.from(bytes));
      this.pendingBytes += bytes.length;
      this.objectBytes += bytes.length;
      if (this.pendingBytes >= 8 * 1024 ** 2 || this.pending.size >= 4096)
        this.flush();
      return expectedId;
    }

    public flush(): void {
      this.batch(() => {
        for (const [id, bytes] of this.pending) super.put(bytes, id);
      });
      this.pending.clear();
      this.pendingBytes = 0;
    }
  }
  const store = new BufferedStore(directory);
  let capturedLeaves = 0;
  try {
    for (const root of roots) {
      const device = lstatSync(root).dev;
      const ignorePath = join(root, ".codefoldersyncignore");
      const ignore = compileIgnore(
        existsSync(ignorePath)
          ? readFileSync(ignorePath, "utf8")
          : defaultIgnore,
      );
      const visit = (parent: string): void => {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.name.toLowerCase() === ".git") continue;
          const path = join(parent, entry.name);
          const stat = lstatSync(path);
          if (stat.dev !== device)
            throw new Error("Acceptance seed refuses a nested mount");
          const local = relative(root, path).split(sep).join("/");
          if (ignore.ignores(local, stat.isDirectory())) continue;
          if (stat.isDirectory()) visit(path);
          else if (policyIncludes(policy, local)) {
            if ((stat.mode & 0o222) !== 0 && !stat.isSymbolicLink())
              throw new Error("Acceptance seed leaf is not protected");
            capturePath(path, store);
            capturedLeaves += 1;
          }
        }
      };
      visit(root);
    }
    store.flush();
    return {
      objects: store.seen.size,
      objectBytes: store.objectBytes,
      capturedLeaves,
    };
  } finally {
    store[Symbol.dispose]();
    chmodSync(join(directory, "objects.sqlite"), 0o400);
    chmodSync(directory, 0o500);
  }
}

/** A fixed-size backing file bounds even transient writes, before extent dedupe. */
export function validateBoundedReflinkStorage(
  storage: BoundedReflinkStorage,
  paths: readonly string[],
): BoundedReflinkBudget {
  if (storage.kind !== "bounded-reflink" || process.platform !== "linux")
    throw new Error("Bounded reflink acceptance requires Linux");
  const namespace = readlinkSync("/proc/self/ns/mnt");
  if (
    !/^mnt:\[\d+\]$/u.test(storage.inheritedMountNamespace) ||
    namespace === storage.inheritedMountNamespace ||
    namespace === readlinkSync("/proc/1/ns/mnt")
  )
    throw new Error("Bounded acceptance requires a private mount namespace");
  const outer = physical(storage.volumeRunRoot);
  // The outer root contains the mount, so validate its sentinel without walking it.
  validateCleanupRunRoot({
    schemaVersion: 1,
    runId: storage.volumeRunId,
    runRoot: outer,
  });
  const mount = physical(storage.mountRoot);
  const image = physical(storage.imagePath);
  if (
    dirname(mount) !== outer ||
    dirname(image) !== outer ||
    !lstatSync(mount).isDirectory()
  )
    throw new Error("Acceptance image and mount must belong to the volume run");
  const imageStat = lstatSync(image);
  if (
    !imageStat.isFile() ||
    imageStat.nlink !== 1 ||
    (imageStat.mode & 0o077) !== 0 ||
    !Number.isSafeInteger(storage.maximumImageBytes) ||
    storage.maximumImageBytes < 256 * 1024 ** 2 ||
    imageStat.size !== storage.maximumImageBytes ||
    imageStat.blocks * 512 > storage.maximumImageBytes
  )
    throw new Error(
      "Acceptance backing image is not independently size-limited",
    );
  const mounted = JSON.parse(
    command("findmnt", [
      "--json",
      "--mountpoint",
      mount,
      "-o",
      "SOURCE,TARGET,FSTYPE",
    ]),
  ) as { readonly filesystems?: readonly Record<string, unknown>[] };
  const filesystem = mounted.filesystems?.[0];
  if (
    mounted.filesystems?.length !== 1 ||
    filesystem?.target !== mount ||
    filesystem.fstype !== "btrfs" ||
    typeof filesystem.source !== "string" ||
    !/^\/dev\/loop\d+$/u.test(filesystem.source)
  )
    throw new Error("Acceptance volume must be its own Btrfs loop mount");
  const loops = JSON.parse(
    command("losetup", [
      "--json",
      "--list",
      "--output",
      "NAME,BACK-FILE",
      filesystem.source,
    ]),
  ) as { readonly loopdevices?: readonly Record<string, unknown>[] };
  if (
    loops.loopdevices?.length !== 1 ||
    loops.loopdevices[0]?.name !== filesystem.source ||
    loops.loopdevices[0]?.["back-file"] !== image
  )
    throw new Error(
      "Acceptance mount does not use the specified bounded image",
    );
  const device = lstatSync(mount).dev;
  if (device === imageStat.dev || statfsSync(mount).type !== 0x9123683e)
    throw new Error("Acceptance volume filesystem identity is invalid");
  for (const path of [...paths, storage.objectTemplate]) {
    const absolute = physical(path);
    if (
      !absolute.startsWith(`${mount}${sep}`) ||
      lstatSync(absolute).dev !== device
    )
      throw new Error(
        "All acceptance trees, state, and objects must share the bounded volume",
      );
  }
  const roots = storage.retainedRoots.map(physical);
  if (roots.length === 0)
    throw new Error("Retained acceptance residue must be inventoried");
  for (const [index, root] of roots.entries()) {
    if (
      root === outer ||
      root.startsWith(`${outer}${sep}`) ||
      outer.startsWith(`${root}${sep}`) ||
      roots.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (other === root || root.startsWith(`${other}${sep}`)),
      )
    )
      throw new Error(
        "Retained acceptance roots overlap each other or the mounted run",
      );
  }
  const retainedAllocatedBytes = roots.reduce(
    (bytes, root) => bytes + inspectPhysicalTree(root).allocatedBytes,
    0,
  );
  const maximumTotalBytes =
    retainedAllocatedBytes + storage.maximumImageBytes + controlReserveBytes;
  if (
    !Number.isSafeInteger(maximumTotalBytes) ||
    maximumTotalBytes > storageLimits.wootbookHardBytes
  )
    throw new Error(
      "Bounded volume and retained residue exceed the hard storage limit",
    );
  return {
    retainedAllocatedBytes,
    imageAllocatedBytes: imageStat.blocks * 512,
    maximumImageBytes: storage.maximumImageBytes,
    controlReserveBytes,
    maximumTotalBytes,
    aboveNormalTarget: maximumTotalBytes > storageLimits.wootbookTargetBytes,
    passed: true,
  };
}

/** Clone only immutable content objects, never peer identity, history, or state. */
export function cloneAcceptanceObjectTemplate(
  template: string,
  destination: string,
): void {
  const source = physical(template);
  const sourceStat = lstatSync(source);
  if (
    !sourceStat.isFile() ||
    (sourceStat.mode & 0o222) !== 0 ||
    sourceStat.nlink !== 1
  )
    throw new Error(
      "Acceptance object template must be a protected standalone database",
    );
  if (existsSync(`${source}-wal`) || existsSync(`${source}-shm`))
    throw new Error(
      "Acceptance object template must be closed and checkpointed",
    );
  if (existsSync(destination))
    throw new Error("Acceptance object database destination exists");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(destination)).dev !== sourceStat.dev)
    throw new Error("Acceptance object clone crosses filesystems");
  command("cp", ["--reflink=always", "--", source, destination]);
  const copy = lstatSync(destination);
  if (
    !copy.isFile() ||
    copy.dev !== sourceStat.dev ||
    copy.ino === sourceStat.ino ||
    copy.nlink !== 1 ||
    copy.size !== sourceStat.size
  )
    throw new Error(
      "Acceptance object clone does not have an independent inode",
    );
  chmodSync(destination, 0o600);
}

function physical(path: string): string {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path ||
    lstatSync(path).isSymbolicLink()
  )
    throw new Error("Acceptance storage paths must be absolute and physical");
  return path;
}

function command(program: string, arguments_: readonly string[]): string {
  const result = spawnSync(program, [...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 ** 2,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error(`Acceptance storage inspection failed: ${program}`);
  return result.stdout;
}
