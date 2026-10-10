import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { capturePath, ObjectStore } from "../dist/v3/objects.js";
import { compileIgnore, defaultIgnore } from "../dist/v3/ignore.js";
import { defaultSyncPolicy, policyIncludes } from "../dist/v3/policy.js";

// Measure exact product chunk deduplication without retaining payloads or
// printing values, names, chunk IDs, or a path-bearing manifest.
const base = resolve(process.argv[2] ?? "");
if (
  !base.includes("/codefoldersync-v3-fixtures/") ||
  !base.endsWith("/masters")
)
  throw new Error("Expected the explicitly selected protected fixture masters");
if (realpathSync(base) !== base || !lstatSync(base).isDirectory())
  throw new Error("Fixture masters must be a physical directory");
const union = new Map();
let currentObjects = new Map();
class MeasuringStore extends ObjectStore {
  put(bytes) {
    const id = createHash("sha256").update(bytes).digest("hex");
    currentObjects.set(id, bytes.length);
    union.set(id, bytes.length);
    return id;
  }
}
const temporary = mkdtempSync(join(tmpdir(), "codefoldersync-object-measure-"));
const sentinel = "readonly-object-measure-v1\n";
writeFileSync(join(temporary, "SENTINEL"), sentinel, { mode: 0o600 });
mkdirSync(join(temporary, "empty-store"));
const store = new MeasuringStore(join(temporary, "empty-store"));
try {
  for (const machineId of ["mattbook", "wootbook", "workermacair"]) {
    currentObjects = new Map();
    const root = join(base, machineId, "Code");
    const rootStat = lstatSync(root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      realpathSync(root) !== root ||
      (rootStat.mode & 0o222) !== 0
    )
      throw new Error("Master must be physical and protected");
    const ignorePath = join(root, ".codefoldersyncignore");
    const ignore = compileIgnore(
      existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : defaultIgnore,
    );
    let capturedEntries = 0;
    let logicalBytes = 0;
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === ".git") continue;
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (stat.dev !== rootStat.dev)
          throw new Error("Master contains a nested mount");
        const local = relative(root, path).replaceAll("\\", "/");
        if (ignore.ignores(local, stat.isDirectory())) continue;
        if (stat.isDirectory()) visit(path);
        else if (policyIncludes(defaultSyncPolicy, local)) {
          if (stat.isFile() && (stat.mode & 0o222) !== 0)
            throw new Error("Master file is not protected");
          capturePath(path, store);
          capturedEntries += 1;
          if (stat.isFile()) logicalBytes += stat.size;
        }
      }
    };
    visit(root);
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        machineId,
        capturedEntries,
        logicalBytes,
        uniqueObjects: currentObjects.size,
        uniqueObjectBytes: [...currentObjects.values()].reduce(
          (sum, bytes) => sum + bytes,
          0,
        ),
        plaintextWritten: false,
        valuesReturned: false,
        passed: true,
      }) + "\n",
    );
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      combinedUniqueObjects: union.size,
      combinedUniqueObjectBytes: [...union.values()].reduce(
        (sum, bytes) => sum + bytes,
        0,
      ),
      namespaceAndDatabaseOverheadIncluded: false,
      acceptanceRun: false,
    }) + "\n",
  );
} catch {
  process.stderr.write(
    "Protected-master object measurement failed; no acceptance is claimed.\n",
  );
  process.exitCode = 1;
} finally {
  store[Symbol.dispose]();
  if (readFileSync(join(temporary, "SENTINEL"), "utf8") !== sentinel)
    throw new Error("Measurement cleanup sentinel changed");
  rmSync(temporary, { recursive: true });
}
