import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { canonicalJson, hashBytes, hashText } from "../v2/hash.js";
import {
  combineScopedNamespace,
  semanticDigest,
  validateNamespaceManifest,
  type ScanResult,
  type RepositoryScope,
} from "./catalog.js";
import type { CompiledIgnore } from "./ignore.js";
import { ObjectStore, regularCapture } from "./objects.js";
import { normalizeRelativePath, portableName, safeTarget } from "./paths.js";
import {
  assertStableRepositoryContext,
  inspectRepositoryContext,
  policyIncludes,
} from "./policy.js";
import {
  schemaVersion,
  type CatalogEntry,
  type NamespaceManifest,
  type ProductConfig,
  type RepositoryContext,
} from "./types.js";

const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/** A new checkout starts from its committed tree, never the old branch's files. */
export async function prepareGitContexts(
  config: ProductConfig,
  baseline: NamespaceManifest,
  accepted: NamespaceManifest,
  observed: ScanResult,
  ignore: CompiledIgnore,
  objects: ObjectStore,
): Promise<{
  readonly baseline: NamespaceManifest;
  readonly accepted: NamespaceManifest;
  readonly catalog: readonly CatalogEntry[];
}> {
  if (config.syncPolicy.mode !== "default-branch")
    return { baseline, accepted, catalog: [] };
  const contexts = new Map(
    observed.observedRepositories.map((value) => [value.path, value]),
  );
  const paths = observed.scope?.paths ?? [];
  const bases: NamespaceManifest[] = [];
  const advanced: RepositoryContext[] = [];
  for (const context of contexts.values()) {
    if (context.branch !== config.syncPolicy.branch || context.head === null)
      continue;
    if (
      paths.some(
        (path) =>
          path !== context.path &&
          (path === "" || context.path.startsWith(`${path}/`)) &&
          !contexts.has(path),
      )
    )
      continue;
    const remote = accepted.repositories.find(
      (value) => value.path === context.path,
    );
    const previous = baseline.repositories.find(
      (value) => value.path === context.path,
    );
    if (remote !== undefined && remote.identity !== context.identity) continue;
    const changesHub = remote === undefined || remote.head !== context.head;
    if (changesHub && remote?.head !== undefined && remote.head !== null) {
      const ancestry = spawnSync(
        "git",
        [
          "--no-optional-locks",
          "-C",
          join(config.root, context.path),
          "merge-base",
          "--is-ancestor",
          remote.head,
          context.head,
        ],
        { stdio: "ignore", env: gitEnvironment, timeout: 15_000 },
      );
      if (ancestry.status !== 0) continue;
    }
    if (
      !changesHub &&
      previous?.identity === context.identity &&
      previous.head === context.head &&
      previous.branch === context.branch
    )
      continue;
    bases.push(
      await committedNamespace(
        config,
        context,
        accepted,
        paths,
        ignore,
        objects,
      ),
    );
    if (changesHub) advanced.push(context);
  }
  let nextBaseline = baseline;
  let nextAccepted = accepted;
  const catalog = new Map<string, CatalogEntry>();
  for (const committed of bases) {
    const scope: RepositoryScope = {
      paths,
      active: committed.repositories,
      guards: [],
      paused: [],
    };
    nextBaseline = combineScopedNamespace(committed, nextBaseline, scope);
    if (
      committed.repositories.some((context) =>
        advanced.some((value) => value.path === context.path),
      )
    )
      nextAccepted = combineScopedNamespace(committed, nextAccepted, scope);
    for (const entry of committed.entries) {
      const path = safeTarget(config.root, entry.path);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      // Bind new-checkout paths to committed node IDs, but force byte capture.
      catalog.set(entry.path, {
        ...entry,
        device: stat.dev,
        inode: stat.ino,
        size: -1,
        mtimeMs: -1,
        ctimeMs: -1,
      });
    }
  }
  return {
    baseline: nextBaseline,
    accepted: nextAccepted,
    catalog: [...catalog.values()],
  };
}

async function committedNamespace(
  config: ProductConfig,
  context: RepositoryContext,
  reference: NamespaceManifest,
  roots: readonly string[],
  ignore: CompiledIgnore,
  objects: ObjectStore,
): Promise<NamespaceManifest> {
  if (context.head === null) throw new Error("Committed context requires HEAD");
  const worktree = join(config.root, context.path);
  const listed = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-C",
      worktree,
      "ls-tree",
      "-rz",
      "--full-tree",
      context.head,
    ],
    {
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (listed.status !== 0)
    throw new Error("Cannot enumerate the committed repository tree");
  const referenceEntries = new Map(
    reference.entries.map((entry) => [entry.path, entry]),
  );
  const orderedRoots = [...roots].sort(
    (left, right) => right.length - left.length,
  );
  const entries = new Map<string, CatalogEntry>();
  const entry = (
    path: string,
    kind: CatalogEntry["kind"],
    manifestId: string | null,
    executable = false,
  ): CatalogEntry => {
    const parent = dirname(path);
    return {
      path,
      parentPath: parent === "." ? null : parent,
      parentNodeId: "",
      name: basename(path),
      portableName: portableName(basename(path)),
      nodeId:
        referenceEntries.get(path)?.nodeId ??
        hashText(`committed:${context.identity}:${context.head}:${path}`),
      kind,
      manifestId,
      executable,
      device: -1,
      inode: -1,
      size: -1,
      mtimeMs: -1,
      ctimeMs: -1,
    };
  };
  const blobs = listed.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const tab = record.indexOf("\t");
      const header = record.slice(0, tab);
      const match =
        /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(
          header,
        );
      if (tab < 0 || match === null)
        throw new Error("Committed tree contains an unsupported entry");
      const path = context.path
        ? `${context.path}/${record.slice(tab + 1)}`
        : record.slice(tab + 1);
      normalizeRelativePath(path);
      const owner = orderedRoots.find(
        (root) => root === "" || path === root || path.startsWith(`${root}/`),
      );
      if (
        owner !== context.path ||
        match[2] !== "blob" ||
        !policyIncludes(config.syncPolicy, path) ||
        ignore.ignores(path, false)
      )
        return [];
      let parent = dirname(path);
      while (parent !== ".") {
        if (ignore.ignores(parent, true)) return [];
        parent = dirname(parent);
      }
      return [{ path, mode: match[1], id: match[3] ?? "" }];
    });
  const child = spawn(
    "git",
    ["--no-optional-locks", "-C", worktree, "cat-file", "--batch"],
    { env: gitEnvironment, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(new Error("Committed blob reader could not start")),
    );
    child.once("close", (status) =>
      status === 0
        ? resolve()
        : reject(new Error("Committed blob reader failed")),
    );
  });
  // Observe early failure even while the binary stream is being consumed.
  void completion.catch(() => {});
  const reader = new BlobReader(child.stdout);
  try {
    for (const blob of blobs) {
      child.stdin.write(`${blob.id}\n`);
      const header = await reader.line();
      const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(header);
      const size = Number(match?.[2]);
      if (match?.[1] !== blob.id || !Number.isSafeInteger(size) || size < 0)
        throw new Error("Committed blob header is invalid");
      if (blob.mode === "120000" && size > 64 * 1024)
        throw new Error("Committed symlink target is too large");
      const hash = createHash(blob.id.length === 40 ? "sha1" : "sha256").update(
        `blob ${size}\0`,
      );
      const capture = regularCapture(size, blob.mode === "100755", objects);
      const target: Buffer[] = [];
      let remaining = size;
      while (remaining > 0) {
        const bytes = await reader.bytes(remaining);
        remaining -= bytes.length;
        hash.update(bytes);
        if (blob.mode === "120000") target.push(Buffer.from(bytes));
        else capture.write(bytes);
      }
      if (
        hash.digest("hex") !== blob.id ||
        !(await reader.bytes(1)).equals(Buffer.from("\n"))
      )
        throw new Error("Committed blob failed its Git object digest");
      const manifestId =
        blob.mode === "120000"
          ? objects.put(
              Buffer.from(
                canonicalJson({
                  schemaVersion,
                  type: "symlink",
                  target: Buffer.concat(target).toString("utf8"),
                  digest: hashBytes(Buffer.concat(target)),
                }),
                "utf8",
              ),
            )
          : capture.finish();
      entries.set(
        blob.path,
        entry(
          blob.path,
          blob.mode === "120000" ? "symlink" : "regular",
          manifestId,
          blob.mode === "100755",
        ),
      );
      let parent = dirname(blob.path);
      while (parent !== ".") {
        if (!entries.has(parent))
          entries.set(parent, entry(parent, "directory", null));
        parent = dirname(parent);
      }
    }
    child.stdin.end();
    await completion;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await completion.catch(() => {});
  }
  assertStableRepositoryContext(
    inspectRepositoryContext(config.root, context.path),
    context,
  );
  const catalog = [...entries.values()]
    .map((value) => ({
      ...value,
      parentNodeId:
        value.parentPath === null
          ? "$root"
          : (entries.get(value.parentPath)?.nodeId ?? ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifest: NamespaceManifest = {
    schemaVersion,
    folderId: config.folderId,
    ignoreDigest: config.ignoreDigest,
    entries: catalog,
    gitBoundaries: [],
    repositories: [context],
    createdAt: new Date().toISOString(),
    digest: semanticDigest(catalog, [], config.ignoreDigest, [context]),
  };
  validateNamespaceManifest(manifest);
  return manifest;
}

class BlobReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered: Buffer = Buffer.alloc(0);
  public constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  private async fill(): Promise<void> {
    if (this.buffered.length > 0) return;
    const value = await this.iterator.next();
    if (value.done || !Buffer.isBuffer(value.value))
      throw new Error("Committed blob stream ended early");
    this.buffered = value.value;
  }
  public async bytes(maximum: number): Promise<Buffer> {
    await this.fill();
    const bytes = this.buffered.subarray(0, maximum);
    this.buffered = this.buffered.subarray(bytes.length);
    return bytes;
  }
  public async line(): Promise<string> {
    const parts: Buffer[] = [];
    let count = 0;
    for (;;) {
      await this.fill();
      const newline = this.buffered.indexOf(10);
      const bytes = await this.bytes(
        newline < 0 ? this.buffered.length : newline + 1,
      );
      parts.push(bytes);
      count += bytes.length;
      if (count > 4096)
        throw new Error("Committed blob header exceeds the limit");
      if (newline >= 0) return Buffer.concat(parts).toString("utf8").trimEnd();
    }
  }
}
