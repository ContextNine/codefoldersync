import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { repositoryNames, type RepositoryName } from "./types.js";

export function createFixture(workspace: string, seed: number): void {
  for (const repository of repositoryNames) {
    createRepository(join(workspace, repository), repository, seed);
  }
}

function createRepository(
  path: string,
  name: RepositoryName,
  seed: number,
): void {
  mkdirSync(join(path, "src", "nested"), { recursive: true });
  mkdirSync(join(path, "docs"), { recursive: true });
  mkdirSync(join(path, "bin"), { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(join(path, "README.md"), `# ${name}\n\nseed ${seed}\n`);
  writeFileSync(join(path, "src", "shared.txt"), `shared baseline ${seed}\n`);
  writeFileSync(join(path, "docs", "modify-delete.md"), "baseline\n");
  writeFileSync(join(path, "docs", "collision"), "baseline-file\n");
  writeFileSync(join(path, "src", "unicode-é.txt"), "unicode baseline\n");
  writeFileSync(join(path, "bin", "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(path, "bin", "run.sh"), 0o755);
  for (let index = 0; index < 8; index += 1) {
    writeFileSync(
      join(path, "src", "nested", `file-${index}.txt`),
      `${name}:${seed}:${index}\n`,
    );
  }
  writeFileSync(
    join(path, "src", "fixture.bin"),
    Buffer.from(
      Array.from({ length: 256 }, (_, index) => (index + seed) % 256),
    ),
  );
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture: initial tree"]);
  writeFileSync(join(path, "src", "nested", "file-0.txt"), `second ${seed}\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture: second state"]);
  writeFileSync(join(path, "staged.txt"), `staged baseline ${seed}\n`);
  git(path, ["add", "staged.txt"]);
  writeFileSync(join(path, "working.txt"), `working baseline ${seed}\n`);
  git(path, ["add", "working.txt"]);
  git(path, ["commit", "-m", "fixture: working base"]);
  writeFileSync(join(path, "working.txt"), `working dirty ${seed}\n`);
  writeFileSync(join(path, "untracked.txt"), `untracked baseline ${seed}\n`);
  writeFileSync(join(path, "staged.txt"), `staged changed ${seed}\n`);
  git(path, ["add", "staged.txt"]);
}
