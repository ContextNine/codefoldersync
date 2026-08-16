import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const runIdPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const sentinelName = ".codefoldersync-run.json";

export interface RunPaths {
  readonly root: string;
  readonly workspace: string;
  readonly control: string;
  readonly tools: string;
}

export function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) {
    throw new Error(
      `Invalid run ID ${JSON.stringify(runId)}; use 3-64 lowercase letters, digits, or hyphens.`,
    );
  }
}

export function resolveRunPaths(runBase: string, runId: string): RunPaths {
  assertRunId(runId);
  if (!isAbsolute(runBase)) {
    throw new Error(`Run base must be absolute: ${runBase}`);
  }
  const base = resolve(runBase);
  const root = resolve(base, runId);
  assertDescendant(base, root);
  return {
    root,
    workspace: join(root, "workspace"),
    control: join(root, "control"),
    tools: join(root, "tools"),
  };
}

export function assertDescendant(parent: string, child: string): void {
  const relation = relative(resolve(parent), resolve(child));
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`${child} is not a strict descendant of ${parent}`);
  }
}

export function assertSafeRelativePath(path: string): void {
  if (path.length === 0 || isAbsolute(path)) {
    throw new Error(`Expected a non-empty relative path: ${path}`);
  }
  const normalized = relative(".", path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Path traversal is not allowed: ${path}`);
  }
}

export function createRunRoot(runBase: string, runId: string): RunPaths {
  const paths = resolveRunPaths(runBase, runId);
  mkdirSync(dirname(paths.root), { recursive: true, mode: 0o700 });
  try {
    lstatSync(paths.root);
    throw new Error(`Run root already exists: ${paths.root}`);
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) {
      throw error;
    }
  }

  mkdirSync(paths.workspace, { recursive: true, mode: 0o700 });
  mkdirSync(paths.control, { recursive: true, mode: 0o700 });
  mkdirSync(paths.tools, { recursive: true, mode: 0o700 });
  const sentinelPath = join(paths.root, sentinelName);
  const descriptor = openSync(sentinelPath, "wx", 0o600);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ schemaVersion: 1, runId, createdAt: new Date().toISOString() })}\n`,
    );
  } finally {
    closeSync(descriptor);
  }
  return paths;
}

export function validateRunRoot(runBase: string, runId: string): RunPaths {
  const paths = resolveRunPaths(runBase, runId);
  const sentinelPath = join(paths.root, sentinelName);
  const actualRoot = realpathSync(paths.root);
  const actualBase = realpathSync(runBase);
  assertDescendant(actualBase, actualRoot);
  const parsed: unknown = JSON.parse(readFileSync(sentinelPath, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("runId" in parsed) ||
    parsed.runId !== runId
  ) {
    throw new Error(`Run sentinel does not match ${runId}: ${sentinelPath}`);
  }
  return paths;
}

export function removeRunRoot(runBase: string, runId: string): void {
  const paths = validateRunRoot(runBase, runId);
  rmSync(paths.root, { recursive: true, force: false });
}
