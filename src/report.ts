import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioResult } from "./types.js";

export function writeMarkdownReport(resultPath: string): string {
  const result = parseResult(readFileSync(resultPath, "utf8"));
  const lines = [
    `# ${result.scenario} ${result.mode}, ${result.runId}`,
    "",
    `Verdict: \`${result.verdict}\``,
    "",
    `Adapter: \`${result.adapter}\``,
    "",
    `Seed: \`${result.seed}\``,
    "",
    `Started: ${result.startedAt}`,
    "",
    `Finished: ${result.finishedAt}`,
    "",
    "| Peer | Passed | Required | Recovered | Issues |",
    "| --- | --- | ---: | ---: | --- |",
    ...Object.entries(result.verification).map(
      ([peer, verification]) =>
        `| ${peer} | ${verification.passed ? "yes" : "no"} | ${verification.requiredOperations} | ${verification.recoveredOperations} | ${verification.issues.map((issue) => issue.code).join(", ") || "none"} |`,
    ),
    "",
    "## Notes",
    "",
    ...(result.notes.length === 0
      ? ["None."]
      : result.notes.map((note) => `- ${note}`)),
    "",
  ];
  const destination = join(dirname(resultPath), "report.md");
  writeFileSync(destination, lines.join("\n"));
  return destination;
}

function parseResult(content: string): ScenarioResult {
  const value: unknown = JSON.parse(content);
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !("verification" in value) ||
    typeof value.verification !== "object" ||
    value.verification === null
  )
    throw new Error("Invalid scenario result");
  return value as ScenarioResult;
}
