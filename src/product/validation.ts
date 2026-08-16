import { isAbsolute, posix, sep } from "node:path";

const idPattern = /^[a-f0-9-]{16,64}$/;
const snapshotIdPattern = /^[a-f0-9]{64}$/;
const unitPattern = /^[^/\\\0]{1,160}$/u;
const peerNamePattern = /^[A-Za-z0-9._-]{1,80}$/;
const sshHostPattern = /^[A-Za-z0-9._%+@:-]{1,255}$/;
const commandPattern = /^[A-Za-z0-9_./-]{1,1024}$/;

export function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) throw new Error(`${label} is invalid`);
}

export function assertSnapshotId(value: string, label = "snapshot ID"): void {
  if (!snapshotIdPattern.test(value)) throw new Error(`${label} is invalid`);
}

export function assertUnit(value: string): void {
  if (!unitPattern.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid repository unit: ${value}`);
  }
}

export function assertPeerName(value: string): void {
  if (!peerNamePattern.test(value)) throw new Error("Peer name is invalid");
}

export function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
}

export function assertSshHost(value: string): void {
  if (!sshHostPattern.test(value) || value.startsWith("-")) {
    throw new Error("SSH host is invalid");
  }
}

export function assertRemoteCommand(value: string): void {
  if (!commandPattern.test(value) || value.startsWith("-")) {
    throw new Error("Remote CodeFolderSync command is invalid");
  }
}

export function assertRelativeFilePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    posix.normalize(value) !== value ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
}

export function normalizedCollisionKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function pathIsInside(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}
