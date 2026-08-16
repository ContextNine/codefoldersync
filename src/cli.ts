#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { runFakeScenario } from "./fake.js";
import {
  detachLive,
  enrollLive,
  prepareLive,
  runLiveScenario,
  verifyLive,
} from "./live.js";
import { writeMarkdownReport } from "./report.js";
import {
  type ScenarioMode,
  type ScenarioName,
  type ScenarioResult,
} from "./types.js";

const [command, ...args] = process.argv.slice(2);

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      printHelp();
      break;
    case "doctor":
      runDoctor(args);
      break;
    case "prepare":
      runPrepare(args);
      break;
    case "enroll":
      await runEnroll(args);
      break;
    case "detach":
      runDetach(args);
      break;
    case "scenario":
      await runScenario(args);
      break;
    case "verify":
      await runVerify(args);
      break;
    case "report":
      runReport(args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function runDetach(commandArgs: readonly string[]): void {
  detachLive(
    loadHarnessConfig(commandArgs),
    requiredOption(commandArgs, "--run"),
  );
  process.stdout.write("Stopped peer daemons and detached local folders.\n");
}

function runDoctor(commandArgs: readonly string[]): void {
  const results = doctor(loadHarnessConfig(commandArgs));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => !result.ready)) process.exitCode = 1;
}

function runPrepare(commandArgs: readonly string[]): void {
  const runId = requiredOption(commandArgs, "--run");
  const seed = integerOption(commandArgs, "--seed");
  const capabilities = prepareLive(loadHarnessConfig(commandArgs), runId, seed);
  process.stdout.write(
    `${JSON.stringify({ runId, seed, capabilities }, null, 2)}\n`,
  );
}

async function runEnroll(commandArgs: readonly string[]): Promise<void> {
  await enrollLive(
    loadHarnessConfig(commandArgs),
    requiredOption(commandArgs, "--run"),
  );
  process.stdout.write(
    "Enrollment and initial three-peer convergence passed.\n",
  );
}

async function runScenario(commandArgs: readonly string[]): Promise<void> {
  const scenario = positional(commandArgs, 0);
  if (!isScenario(scenario)) throw new Error(`Invalid scenario: ${scenario}`);
  const adapter = option(commandArgs, "--adapter") ?? "fake";
  if (adapter !== "fake" && adapter !== "codefoldersync")
    throw new Error(`Invalid adapter: ${adapter}`);
  const mode = option(commandArgs, "--mode") ?? "raw";
  if (!isMode(mode)) throw new Error(`Invalid mode: ${mode}`);
  const runId = requiredOption(commandArgs, "--run");
  const seed = integerOption(commandArgs, "--seed");
  let result: ScenarioResult;
  let resultBase: string;
  if (adapter === "fake") {
    resultBase = resolve(requiredOption(commandArgs, "--base"));
    result = runFakeScenario({
      base: resultBase,
      runId,
      scenario,
      mode,
      seed,
      injectLoss: commandArgs.includes("--inject-loss"),
    });
  } else {
    resultBase = resolve(option(commandArgs, "--result-base") ?? ".");
    result = await runLiveScenario({
      config: loadHarnessConfig(commandArgs),
      runId,
      scenario,
      mode,
      seed,
    });
  }
  writeResult(resultBase, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict !== "pass") process.exitCode = 1;
}

async function runVerify(commandArgs: readonly string[]): Promise<void> {
  const result = await verifyLive(
    loadHarnessConfig(commandArgs),
    requiredOption(commandArgs, "--run"),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Object.values(result).some((peer) => !peer.passed)) process.exitCode = 1;
}

function runReport(commandArgs: readonly string[]): void {
  const path = writeMarkdownReport(
    resolve(requiredOption(commandArgs, "--result")),
  );
  process.stdout.write(`${path}\n`);
}

function loadHarnessConfig(commandArgs: readonly string[]) {
  return loadConfig(
    resolve(option(commandArgs, "--config") ?? "config.example.json"),
  );
}

function writeResult(base: string, result: ScenarioResult): void {
  const resultDirectory = resolve(base, "results", result.runId);
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    resolve(resultDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

function positional(
  commandArgs: readonly string[],
  index: number,
): string | undefined {
  return commandArgs.filter(
    (value) => !value.startsWith("--") && !isOptionValue(commandArgs, value),
  )[index];
}

function isOptionValue(commandArgs: readonly string[], value: string): boolean {
  const index = commandArgs.indexOf(value);
  return index > 0 && commandArgs[index - 1]?.startsWith("--") === true;
}

function option(
  commandArgs: readonly string[],
  name: string,
): string | undefined {
  const index = commandArgs.indexOf(name);
  return index === -1 ? undefined : commandArgs[index + 1];
}

function requiredOption(commandArgs: readonly string[], name: string): string {
  const value = option(commandArgs, name);
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing ${name}`);
  return value;
}

function integerOption(commandArgs: readonly string[], name: string): number {
  const value = Number(requiredOption(commandArgs, name));
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

function isScenario(value: string | undefined): value is ScenarioName {
  return value === "serial" || value === "conflict" || value === "churn";
}

function isMode(value: string): value is ScenarioMode {
  return value === "raw" || value === "guarded";
}

function printHelp(): void {
  process.stdout.write(`CodeFolderSync safety harness

Commands:
  harness doctor --config <path>
  harness prepare --config <path> --run <id> --seed <n>
  harness enroll --config <path> --run <id>
  harness detach --config <path> --run <id>
  harness scenario <serial|conflict|churn> --adapter fake --mode <raw|guarded> --run <id> --seed <n> --base <absolute-path>
  harness scenario <serial|conflict|churn> --adapter codefoldersync --mode <raw|guarded> --run <id> --seed <n> --config <path>
  harness verify --config <path> --run <id>
  harness report --result <result.json>
`);
}
