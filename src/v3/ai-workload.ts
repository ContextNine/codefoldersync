import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, hashText } from "../v2/hash.js";

export const aiWorkloadPrompt = `Refactor this TypeScript repository to pass verify.mjs.

The repository has eight domain directories and sixty-four handlers. Introduce a shared RequestContext type and update every handler to accept context before input. Move the legacy context module to src/shared/request-context.ts, create src/shared/context-id.ts, delete src/legacy/obsolete.ts, and update all imports. Keep the change coherent and readable. Do not weaken or edit verify.mjs. Run node verify.mjs before finishing.`;

export interface AiWriterSpec {
  readonly runId: string;
  readonly allowedRunRoot: string;
  readonly workspace: string;
  readonly privateEvidenceDir: string;
  readonly command: readonly string[];
  readonly modelId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface AiWorkspaceEntry {
  readonly digest: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface AiPathState {
  readonly pathHash: string;
  readonly stateDigest: string | null;
}

interface MutationCassette {
  readonly schemaVersion: 1;
  readonly promptDigest: string;
  readonly initialDigest: string;
  readonly finalDigest: string;
  readonly operations: readonly (
    | {
        readonly kind: "write";
        readonly path: string;
        readonly contentBase64: string;
        readonly mode: number;
        readonly firstObservedMs: number;
      }
    | {
        readonly kind: "delete";
        readonly path: string;
        readonly firstObservedMs: number;
      }
  )[];
}

export interface AiWriterResult {
  readonly modelId: string;
  readonly promptDigest: string;
  readonly initialDigest: string;
  readonly finalDigest: string;
  readonly cassetteDigest: string;
  readonly changedCodeFiles: number;
  readonly changedDirectories: number;
  readonly createdFiles: number;
  readonly deletedFiles: number;
  readonly writerDurationMs: number;
  readonly firstChangeMs: number;
  readonly lastChangeMs: number;
  readonly finalPathStates: readonly AiPathState[];
  readonly passed: true;
}

export function createAiWorkloadFixture(workspace: string): void {
  const root = resolve(workspace);
  if (existsSync(root))
    throw new Error("AI workload fixture destination exists");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let domain = 0; domain < 8; domain += 1) {
    const directory = join(root, "src", "domains", `domain-${domain}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let handler = 0; handler < 8; handler += 1) {
      writeFileSync(
        join(directory, `handler-${handler}.ts`),
        `export function handle${domain}_${handler}(input: string): string {\n  return ${JSON.stringify(`${domain}:${handler}:`)} + input;\n}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
  }
  mkdirSync(join(root, "src", "legacy"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "src", "legacy", "context.ts"),
    "export interface LegacyContext { requestId: string }\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    join(root, "src", "legacy", "obsolete.ts"),
    "export const obsolete = true;\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  writeFileSync(join(root, "verify.mjs"), verificationProgram(), {
    encoding: "utf8",
    mode: 0o700,
    flag: "wx",
  });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "codefoldersync-ai-workload", private: true, type: "module", scripts: { test: "node verify.mjs" } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  runFixtureGit(root, ["init"]);
  runFixtureGit(root, ["add", "--all"]);
  runFixtureGit(root, ["commit", "-m", "fixture: initial AI workload"]);
}

export async function runAiWriter(spec: AiWriterSpec): Promise<AiWriterResult> {
  validateWriterSpec(spec);
  const initial = snapshotAiWorkspace(spec.workspace);
  const initialDigest = aiWorkspaceDigest(initial);
  const firstObserved = new Map<string, number>();
  let previous = initial;
  let closed = false;
  const started = performance.now();
  const monitor = (async () => {
    while (!closed) {
      await delay(spec.pollIntervalMs);
      const current = snapshotAiWorkspace(spec.workspace);
      recordChanges(
        previous,
        current,
        firstObserved,
        performance.now() - started,
      );
      previous = current;
    }
  })();
  const command = spec.command[0];
  if (command === undefined) throw new Error("AI writer command is missing");
  let childResult: { readonly status: number; readonly bytes: number };
  try {
    childResult = await new Promise<{
      readonly status: number;
      readonly bytes: number;
    }>((resolvePromise, reject) => {
      const child = spawn(command, spec.command.slice(1), {
        cwd: spec.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG ?? "C.UTF-8",
          CODEFOLDERSYNC_AI_WORKSPACE: spec.workspace,
        },
      });
      let bytes = 0;
      const count = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) child.kill("SIGTERM");
      };
      child.stdout.on("data", count);
      child.stderr.on("data", count);
      child.on("error", reject);
      child.on("close", (status) =>
        resolvePromise({ status: status ?? 1, bytes }),
      );
      child.stdin.end(`${spec.prompt}\n`);
      let forced: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, spec.timeoutMs);
      child.once("close", () => {
        clearTimeout(timeout);
        if (forced !== undefined) clearTimeout(forced);
      });
    });
  } finally {
    closed = true;
    await monitor;
  }
  const final = snapshotAiWorkspace(spec.workspace);
  recordChanges(previous, final, firstObserved, performance.now() - started);
  if (childResult.bytes > 16 * 1024 * 1024)
    throw new Error("AI writer output exceeded 16 MiB");
  if (childResult.status !== 0) throw new Error("AI writer command failed");
  const verification = spawnSync(
    process.execPath,
    [join(spec.workspace, "verify.mjs")],
    {
      cwd: spec.workspace,
      encoding: "utf8",
    },
  );
  if (verification.status !== 0)
    throw new Error("AI workload verification failed");
  if (
    final["verify.mjs"]?.digest !== initial["verify.mjs"]?.digest ||
    final["verify.mjs"]?.mode !== initial["verify.mjs"]?.mode
  )
    throw new Error("AI workload changed its verifier");
  const changes = changedAiWorkspacePaths(initial, final);
  const codeChanges = changes.filter((path) => path.endsWith(".ts"));
  const changedDirectories = new Set(codeChanges.map((path) => dirname(path)))
    .size;
  const createdFiles = changes.filter(
    (path) => initial[path] === undefined && final[path] !== undefined,
  ).length;
  const deletedFiles = changes.filter(
    (path) => initial[path] !== undefined && final[path] === undefined,
  ).length;
  if (codeChanges.length < 50 || changedDirectories < 8)
    throw new Error(
      "AI workload did not change enough code files and directories",
    );
  if (
    final["src/shared/request-context.ts"] === undefined ||
    final["src/shared/context-id.ts"] === undefined ||
    final["src/legacy/context.ts"] !== undefined ||
    final["src/legacy/obsolete.ts"] !== undefined
  )
    throw new Error(
      "AI workload did not complete the required create, move, and delete operations",
    );
  const cassette = createCassette(spec, initial, final, firstObserved);
  mkdirSync(spec.privateEvidenceDir, { recursive: true, mode: 0o700 });
  const cassettePath = join(
    spec.privateEvidenceDir,
    "ai-mutation-cassette.json",
  );
  if (existsSync(cassettePath))
    throw new Error("AI mutation cassette already exists");
  writeFileSync(cassettePath, `${JSON.stringify(cassette, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(cassettePath, 0o600);
  const observed = [...firstObserved.values()].sort(
    (left, right) => left - right,
  );
  return {
    modelId: spec.modelId,
    promptDigest: cassette.promptDigest,
    initialDigest,
    finalDigest: cassette.finalDigest,
    cassetteDigest: hashText(canonicalJson(cassette)),
    changedCodeFiles: codeChanges.length,
    changedDirectories,
    createdFiles,
    deletedFiles,
    writerDurationMs: milliseconds(performance.now() - started),
    firstChangeMs: milliseconds(observed[0] ?? 0),
    lastChangeMs: milliseconds(observed.at(-1) ?? 0),
    finalPathStates: changes.map((path) => ({
      pathHash: hashText(path),
      stateDigest: aiPathStateDigest(final[path]),
    })),
    passed: true,
  };
}

export function replayAiMutationCassette(
  cassettePath: string,
  workspace: string,
): { readonly finalDigest: string; readonly operations: number } {
  const cassette = readCassette(cassettePath);
  const initial = snapshotAiWorkspace(workspace);
  if (aiWorkspaceDigest(initial) !== cassette.initialDigest)
    throw new Error("AI replay fixture does not match the cassette baseline");
  for (const operation of cassette.operations) {
    const path = safeWorkspacePath(workspace, operation.path);
    if (operation.kind === "delete") {
      if (existsSync(path)) unlinkSync(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-codefoldersync-replay`;
    writeFileSync(temporary, Buffer.from(operation.contentBase64, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    chmodSync(path, operation.mode);
  }
  const finalDigest = aiWorkspaceDigest(snapshotAiWorkspace(workspace));
  if (finalDigest !== cassette.finalDigest)
    throw new Error("AI mutation replay differs from the recorded final tree");
  return { finalDigest, operations: cassette.operations.length };
}

function createCassette(
  spec: AiWriterSpec,
  initial: Readonly<Record<string, AiWorkspaceEntry>>,
  final: Readonly<Record<string, AiWorkspaceEntry>>,
  firstObserved: ReadonlyMap<string, number>,
): MutationCassette {
  const operations = changedAiWorkspacePaths(initial, final)
    .map((path) => {
      const observed = milliseconds(firstObserved.get(path) ?? spec.timeoutMs);
      const entry = final[path];
      if (entry === undefined)
        return { kind: "delete" as const, path, firstObservedMs: observed };
      return {
        kind: "write" as const,
        path,
        contentBase64: readFileSync(
          join(spec.workspace, ...path.split("/")),
        ).toString("base64"),
        mode: entry.mode,
        firstObservedMs: observed,
      };
    })
    .sort(
      (left, right) =>
        left.firstObservedMs - right.firstObservedMs ||
        left.path.localeCompare(right.path),
    );
  return {
    schemaVersion: 1,
    promptDigest: hashText(spec.prompt),
    initialDigest: aiWorkspaceDigest(initial),
    finalDigest: aiWorkspaceDigest(final),
    operations,
  };
}

export function snapshotAiWorkspace(
  root: string,
): Record<string, AiWorkspaceEntry> {
  const result: Record<string, AiWorkspaceEntry> = {};
  const absoluteRoot = resolve(root);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)),
    )) {
      if (directory === absoluteRoot && entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const local = relative(absoluteRoot, path).split(sep).join("/");
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        const content = readFileSync(path);
        result[local] = {
          digest: hashText(content.toString("base64")),
          bytes: content.length,
          mode: stat.mode & 0o7777,
        };
      } else {
        throw new Error("AI workload fixture contains an unsupported object");
      }
    }
  };
  visit(absoluteRoot);
  return result;
}

function runFixtureGit(root: string, args: readonly string[]): void {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=CodeFolderSync Acceptance",
      "-c",
      "user.email=acceptance@invalid.example",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0)
    throw new Error("AI workload fixture Git setup failed");
}

export function aiWorkspaceDigest(
  snapshotValue: Readonly<Record<string, AiWorkspaceEntry>>,
): string {
  return hashText(
    canonicalJson(
      Object.entries(snapshotValue)
        .map(
          ([path, entry]) => [path, semanticAiWorkspaceEntry(entry)] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function changedAiWorkspacePaths(
  before: Readonly<Record<string, AiWorkspaceEntry>>,
  after: Readonly<Record<string, AiWorkspaceEntry>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (path) =>
        canonicalJson(semanticAiWorkspaceEntry(before[path])) !==
        canonicalJson(semanticAiWorkspaceEntry(after[path])),
    )
    .sort();
}

function recordChanges(
  before: Readonly<Record<string, AiWorkspaceEntry>>,
  after: Readonly<Record<string, AiWorkspaceEntry>>,
  firstObserved: Map<string, number>,
  elapsedMs: number,
): void {
  for (const path of changedAiWorkspacePaths(before, after))
    if (!firstObserved.has(path)) firstObserved.set(path, elapsedMs);
}

export function aiPathStateDigest(
  entry: AiWorkspaceEntry | undefined,
): string | null {
  const semantic = semanticAiWorkspaceEntry(entry);
  return semantic === null ? null : hashText(canonicalJson(semantic));
}

/** CodeFolderSync preserves executability, not platform-specific permission
 * bits. Visibility evidence therefore compares bytes and the executable bit
 * while the private cassette still retains the source mode for exact replay. */
function semanticAiWorkspaceEntry(entry: AiWorkspaceEntry | undefined) {
  return entry === undefined
    ? null
    : {
        digest: entry.digest,
        bytes: entry.bytes,
        executable: (entry.mode & 0o111) !== 0,
      };
}

function readCassette(path: string): MutationCassette {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("AI mutation cassette is invalid");
  const cassette = value as MutationCassette;
  if (
    cassette.schemaVersion !== 1 ||
    typeof cassette.initialDigest !== "string" ||
    typeof cassette.finalDigest !== "string" ||
    !Array.isArray(cassette.operations)
  )
    throw new Error("AI mutation cassette is invalid");
  return cassette;
}

function safeWorkspacePath(workspace: string, local: string): string {
  if (local.length === 0 || local.startsWith("/") || local.includes("\0"))
    throw new Error("AI mutation path is invalid");
  const root = resolve(workspace);
  const path = resolve(root, ...local.split("/"));
  if (!path.startsWith(`${root}${sep}`))
    throw new Error("AI mutation escapes the workspace");
  return path;
}

function validateWriterSpec(spec: AiWriterSpec): void {
  if (!isAbsolute(spec.allowedRunRoot) || !isAbsolute(spec.workspace))
    throw new Error("AI workload roots must be absolute");
  const runRoot = resolve(spec.allowedRunRoot);
  const workspace = resolve(spec.workspace);
  if (!workspace.startsWith(`${runRoot}${sep}`))
    throw new Error("AI workload workspace escapes the allowed run root");
  if (
    !existsSync(join(runRoot, "SENTINEL")) ||
    !readFileSync(join(runRoot, "SENTINEL"), "utf8").startsWith(spec.runId)
  )
    throw new Error("AI workload sentinel does not match the run");
  if (spec.command.length === 0 || spec.modelId.trim().length === 0)
    throw new Error("AI workload requires an explicit model command and ID");
  if (spec.prompt.trim().length === 0)
    throw new Error("AI workload prompt is empty");
  if (spec.timeoutMs < 1_000 || spec.pollIntervalMs < 10)
    throw new Error("AI workload timing configuration is invalid");
}

function verificationProgram(): string {
  return `import { existsSync, readFileSync } from "node:fs";

const failures = [];
for (let domain = 0; domain < 8; domain += 1) {
  for (let handler = 0; handler < 8; handler += 1) {
    const path = new URL(\`./src/domains/domain-\${domain}/handler-\${handler}.ts\`, import.meta.url);
    const source = readFileSync(path, "utf8");
    if (!source.includes("RequestContext")) failures.push(path.pathname);
    if (!/\(context:\\s*RequestContext,\\s*input:\\s*string\)/u.test(source)) failures.push(path.pathname);
  }
}
if (!existsSync(new URL("./src/shared/request-context.ts", import.meta.url))) failures.push("missing-request-context");
if (!existsSync(new URL("./src/shared/context-id.ts", import.meta.url))) failures.push("missing-context-id");
if (existsSync(new URL("./src/legacy/context.ts", import.meta.url))) failures.push("legacy-context-remains");
if (existsSync(new URL("./src/legacy/obsolete.ts", import.meta.url))) failures.push("obsolete-remains");
if (failures.length > 0) {
  process.stderr.write(\`verification failed for \${failures.length} entries\\n\`);
  process.exitCode = 1;
}
`;
}

function milliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
