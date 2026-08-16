#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (command === "conflict") {
  const [workspace, peer] = required(args, 2, "conflict <workspace> <peer>");
  const path = join(resolve(workspace), "repo-0", "real-conflict.txt");
  const content = `intentional-three-way-${peer}\n`;
  writeFileSync(path, content);
  print({ command, peer, relativePath: "repo-0/real-conflict.txt", content });
} else if (command === "seed-churn") {
  const [workspace, repository, peer] = required(
    args,
    3,
    "seed-churn <workspace> <repository> <peer>",
  );
  const root = join(resolve(workspace), repository, "agent-churn-seed", peer);
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    const suffix = padded(index);
    writeFileSync(
      join(root, `rename-${suffix}.txt`),
      `rename seed ${peer} ${suffix}\n`,
    );
    writeFileSync(
      join(root, `delete-${suffix}.txt`),
      `delete seed ${peer} ${suffix}\n`,
    );
    symlinkSync(`seed-target-${suffix}`, join(root, `link-${suffix}`));
    writeFileSync(
      join(root, `mode-${suffix}.sh`),
      `#!/bin/sh\n# ${peer} ${suffix}\n`,
    );
  }
  print({ command, peer, repository, seeded: 80 });
} else if (command === "churn" || command === "churn-resume") {
  const resume = command === "churn-resume";
  const values = resume
    ? required(
        args,
        6,
        "churn-resume <workspace> <repository> <peer> <count> <start> <result-path>",
      )
    : required(
        args,
        5,
        "churn <workspace> <repository> <peer> <count> <result-path>",
      );
  const [workspace, repository, peer, rawCount] = values;
  const rawStart = resume ? values[4] : "0";
  const resultPath = resume ? values[5] : values[4];
  if (resultPath === undefined) throw new Error("Churn result path is missing");
  const count = Number(rawCount);
  const start = Number(rawStart);
  if (!Number.isSafeInteger(count) || count < 84)
    throw new Error("Churn count must be an integer of at least 84");
  if (!Number.isSafeInteger(start) || start < 0 || start >= count)
    throw new Error("Churn start is invalid");
  const repositoryRoot = join(resolve(workspace), repository);
  const seed = join(repositoryRoot, "agent-churn-seed", peer);
  const output = join(repositoryRoot, "agent-churn", peer);
  mkdirSync(output, { recursive: true });
  const counts: Record<string, number> = {};
  const witness = createHash("sha256");
  for (let index = start; index < count; index += 1) {
    const suffix = padded(index);
    let kind: string;
    if (index < 20) {
      kind = "rename";
      renameSync(
        join(seed, `rename-${suffix}.txt`),
        join(output, `renamed-${suffix}.txt`),
      );
    } else if (index < 40) {
      kind = "delete";
      unlinkSync(join(seed, `delete-${padded(index - 20)}.txt`));
    } else if (index < 60) {
      kind = "symlink-retarget";
      const link = join(seed, `link-${padded(index - 40)}`);
      unlinkSync(link);
      symlinkSync(`retarget-${peer}-${suffix}`, link);
    } else if (index < 80) {
      kind = "chmod";
      chmodSync(join(seed, `mode-${padded(index - 60)}.sh`), 0o755);
    } else if (index < 84) {
      kind = "git-commit";
      const path = join(output, `git-${suffix}.txt`);
      writeFileSync(path, `git operation ${peer} ${suffix}\n`);
      git(repositoryRoot, ["add", "."]);
      git(repositoryRoot, [
        "-c",
        "user.name=CodeFolderSync Fleet",
        "-c",
        "user.email=fleet@invalid",
        "commit",
        "-m",
        `fleet ${peer} ${suffix}`,
      ]);
    } else {
      const content = `agent operation ${peer} ${suffix}\n`;
      const path = join(output, `save-${suffix}.txt`);
      if (index % 10 === 0) {
        kind = "atomic-save";
        const temporary = join(output, `.codefoldersync-churn-${suffix}`);
        writeFileSync(temporary, content);
        renameSync(temporary, path);
      } else if (index % 10 === 1) {
        kind = "executable-save";
        writeFileSync(path, `#!/bin/sh\n# ${content}`, { mode: 0o755 });
      } else {
        kind = "save";
        writeFileSync(path, content);
      }
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
    witness.update(`${index}\0${kind}\0${peer}\0${repository}\n`);
  }
  const result = {
    command,
    peer,
    repository,
    operations: count,
    resumedAt: start,
    executedOperations: count - start,
    counts,
    witnessDigest: witness.digest("hex"),
  };
  mkdirSync(dirname(resolve(resultPath)), { recursive: true });
  writeFileSync(resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
  print(result);
} else if (command === "large-middle") {
  const [path, peer] = required(args, 2, "large-middle <path> <peer>");
  const descriptor = openSync(resolve(path), "r+");
  const bytes = Buffer.from(`middle-edit-${peer}-${Date.now()}\n`, "utf8");
  try {
    writeSync(descriptor, bytes, 0, bytes.length, 32 * 1024 * 1024);
  } finally {
    closeSync(descriptor);
  }
  print({ command, peer, offset: 32 * 1024 * 1024, bytes: bytes.length });
} else if (command === "archive-conflicts") {
  const [workspace, destination] = required(
    args,
    2,
    "archive-conflicts <workspace> <destination>",
  );
  const repository = join(resolve(workspace), "repo-0");
  const target = resolve(destination);
  mkdirSync(target, { recursive: true });
  const archived = readdirSync(repository)
    .filter(
      (name) =>
        name.startsWith("real-conflict.") &&
        name.includes("CODEFOLDERSYNC-CONFLICT"),
    )
    .sort();
  for (const name of archived)
    renameSync(join(repository, name), join(target, name));
  print({ command, archived });
} else {
  throw new Error("Unknown fleet mutation command");
}

function required(
  values: readonly string[],
  count: 2,
  usage: string,
): [string, string];
function required(
  values: readonly string[],
  count: 3,
  usage: string,
): [string, string, string];
function required(
  values: readonly string[],
  count: 5,
  usage: string,
): [string, string, string, string, string];
function required(
  values: readonly string[],
  count: 6,
  usage: string,
): [string, string, string, string, string, string];
function required(
  values: readonly string[],
  count: number,
  usage: string,
): string[] {
  if (values.length !== count) throw new Error(`Usage: ${usage}`);
  return [...values];
}

function padded(value: number): string {
  return String(value).padStart(5, "0");
}

function git(root: string, values: readonly string[]): void {
  const result = spawnSync("git", values, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `git ${values[0]} failed with ${String(result.status)}`,
    );
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
