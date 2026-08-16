import { existsSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { saveConfig, validateConfig } from "./config.js";
import { HubTransport } from "./transport.js";
import type { ProductConfig, RepositoryConfig } from "./types.js";

export async function addRepositoryV2(
  config: ProductConfig,
  configPath: string,
  name: string,
): Promise<ProductConfig> {
  if (config.repositories.some((repository) => repository.name === name))
    throw new Error(`Repository is already configured: ${name}`);
  const root = join(config.root, name);
  const git = join(root, ".git");
  if (
    !existsSync(root) ||
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink() ||
    !existsSync(git) ||
    !lstatSync(git).isDirectory()
  ) {
    throw new Error(`Repository requires an in-tree .git directory: ${name}`);
  }
  const repository: RepositoryConfig = { name, rootNodeId: randomUUID() };
  const repositories = [...config.repositories, repository].sort(
    (left, right) => left.name.localeCompare(right.name, "en"),
  );
  await using transport = await HubTransport.connect(config.hub);
  await transport.updateRepositories(
    config.folderId,
    config.repositories.map((value) => value.name),
    repositories,
  );
  const updated: ProductConfig = { ...config, repositories };
  validateConfig(updated);
  saveConfig(configPath, updated);
  return updated;
}

export async function removeRepositoryV2(
  config: ProductConfig,
  configPath: string,
  name: string,
): Promise<ProductConfig> {
  if (!config.repositories.some((repository) => repository.name === name))
    throw new Error(`Repository is not configured: ${name}`);
  const repositories = config.repositories.filter(
    (repository) => repository.name !== name,
  );
  if (repositories.length === 0)
    throw new Error("CodeFolderSync requires at least one active repository");
  await using transport = await HubTransport.connect(config.hub);
  await transport.updateRepositories(
    config.folderId,
    config.repositories.map((value) => value.name),
    repositories,
  );
  const updated: ProductConfig = { ...config, repositories };
  validateConfig(updated);
  saveConfig(configPath, updated);
  return updated;
}

export async function refreshRepositoryMembershipV2(
  config: ProductConfig,
  configPath: string,
): Promise<ProductConfig> {
  await using transport = await HubTransport.connect(config.hub);
  const folder = await transport.getFolder(config.folderId);
  const updated: ProductConfig = {
    ...config,
    folderName: folder.folderName,
    repositories: folder.repositories,
  };
  validateConfig(updated);
  saveConfig(configPath, updated);
  return updated;
}
