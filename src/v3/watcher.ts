import {
  lstatSync,
  readdirSync,
  watch,
  type Dirent,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { CompiledIgnore } from "./ignore.js";

export interface NamespaceWatcher {
  readonly refresh: () => void;
  readonly close: () => void;
}

/**
 * Linux recursive fs.watch walks excluded trees and can stall under ignored
 * dependency churn. Watch included directories individually there. A parent
 * event dirties the full scan before a newly created child needs its own watch.
 */
export function watchIncludedNamespace(
  root: string,
  ignore: CompiledIgnore,
  onChange: () => void,
  onError: (error: Error) => void,
): NamespaceWatcher {
  if (platform() !== "linux") {
    const watcher = watch(root, { recursive: true }, onChange);
    watcher.on("error", onError);
    return { refresh: () => undefined, close: () => watcher.close() };
  }

  const watchers = new Map<string, FSWatcher>();
  const refresh = (): void => {
    const desired = discoverIncludedDirectories(root, ignore);
    for (const [path, watcher] of watchers)
      if (!desired.has(path)) {
        watcher.close();
        watchers.delete(path);
      }
    for (const path of desired) {
      if (watchers.has(path)) continue;
      try {
        const watcher = watch(path, { recursive: false }, onChange);
        watcher.on("error", (error) => {
          watcher.close();
          watchers.delete(path);
          onError(error);
        });
        watchers.set(path, watcher);
      } catch (error) {
        if (!isMissing(error)) throw error;
        onChange();
      }
    }
  };
  refresh();
  return {
    refresh,
    close: () => {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

function discoverIncludedDirectories(
  root: string,
  ignore: CompiledIgnore,
): Set<string> {
  const result = new Set<string>([root]);
  const rootDevice = lstatSync(root).dev;
  const walk = (directory: string, relativeDirectory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const path = join(directory, entry.name);
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (ignore.ignores(relativePath, true) || stat.dev !== rootDevice)
        continue;
      result.add(path);
      walk(path, relativePath);
    }
  };
  walk(root, "");
  return result;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
