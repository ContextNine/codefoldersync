import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

/** Database-free commands must not load the experimental Node 22 SQLite module.
 * Keep all runtime warnings enabled, including warnings from backup tools. */
export function openDatabase(
  ...args: ConstructorParameters<typeof DatabaseSync>
): DatabaseSync {
  const { DatabaseSync } =
    require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(...args);
}
