import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = openSync(temporary, "wx", mode);
  try {
    writeFileSync(descriptor, data, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
