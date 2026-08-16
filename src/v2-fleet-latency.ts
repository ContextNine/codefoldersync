#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [role, ...args] = process.argv.slice(2);

if (role === "observe") {
  const [path, rawSamples] = args;
  if (path === undefined || rawSamples === undefined)
    throw new Error("observe requires <path> <samples>");
  const samples = Number(rawSamples);
  let previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  process.stdout.write("ready\n");
  let observed = 0;
  while (observed < samples) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== null && current !== previous) {
      previous = current;
      observed += 1;
      process.stdout.write(`${JSON.stringify({ value: current })}\n`);
    }
    await delay(10);
  }
} else if (role === "drive") {
  const [
    localPath,
    rawSamples,
    host,
    remoteNode,
    remoteScript,
    remotePath,
    resultPath,
  ] = args;
  if (
    localPath === undefined ||
    rawSamples === undefined ||
    host === undefined ||
    remoteNode === undefined ||
    remoteScript === undefined ||
    remotePath === undefined
  )
    throw new Error(
      "drive requires <local-path> <samples> <host> <remote-node> <remote-script> <remote-path>",
    );
  const samples = Number(rawSamples);
  const child = spawn(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      host,
      remoteNode,
      remoteScript,
      "observe",
      remotePath,
      String(samples),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const ready = await nextLine(iterator, 15_000);
  if (ready !== "ready")
    throw new Error(`Observer did not become ready: ${ready}`);
  const latencies: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const value = `fleet-latency-${index}-${Date.now()}\n`;
    const started = performance.now();
    writeFileSync(localPath, value);
    const line = await nextLine(iterator, 5_000);
    const observed = JSON.parse(line) as { readonly value?: unknown };
    if (observed.value !== value)
      throw new Error(`Observed wrong version at sample ${index}`);
    latencies.push(performance.now() - started);
    await delay(75);
  }
  lines.close();
  const sorted = [...latencies].sort((left, right) => left - right);
  const result = `${JSON.stringify(
    {
      samples,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maximumMs: sorted.at(-1) ?? 0,
      latenciesMs: latencies,
    },
    null,
    2,
  )}\n`;
  if (resultPath !== undefined) writeFileSync(resultPath, result);
  process.stdout.write(result);
} else {
  throw new Error("Usage: v2-fleet-latency <observe|drive> ...");
}

async function nextLine(
  iterator: AsyncIterator<string>,
  timeoutMs: number,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next().then((result) => {
        if (result.done) throw new Error("Observer exited early");
        return result.value;
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for remote visibility")),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}
