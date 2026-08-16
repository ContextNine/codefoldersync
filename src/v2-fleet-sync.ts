#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./v2/config.js";
import { syncFolderV2 } from "./v2/engine.js";

const [configPath, resultPath] = process.argv.slice(2);
if (configPath === undefined || resultPath === undefined)
  throw new Error("Usage: v2-fleet-sync <config> <result-path>");

const result = await syncFolderV2(loadConfig(resolve(configPath)));
writeFileSync(resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "offline" || result.status === "inconclusive")
  process.exitCode = 1;
