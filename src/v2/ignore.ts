import { existsSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readIgnorePatterns } from "./config.js";
import { HubTransport } from "./transport.js";
import type { ProductConfig } from "./types.js";

export async function pushIgnoreRulesV2(
  config: ProductConfig,
): Promise<readonly string[]> {
  const patterns = readIgnorePatterns(config.root);
  await using transport = await HubTransport.connect(config.hub);
  const folder = await transport.getFolder(config.folderId);
  await transport.updateIgnorePatterns(
    config.folderId,
    folder.ignorePatterns,
    patterns,
  );
  return patterns;
}

export async function pullIgnoreRulesV2(
  config: ProductConfig,
): Promise<readonly string[]> {
  await using transport = await HubTransport.connect(config.hub);
  const folder = await transport.getFolder(config.folderId);
  const path = join(config.root, ".codefoldersyncignore");
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(
    temporary,
    folder.ignorePatterns.length === 0
      ? ""
      : `${folder.ignorePatterns.join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  if (existsSync(path)) {
    const recovery = join(
      config.stateDir,
      "recovery",
      `.codefoldersyncignore-${randomUUID()}`,
    );
    renameSync(path, recovery);
  }
  renameSync(temporary, path);
  return folder.ignorePatterns;
}
