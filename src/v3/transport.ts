import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { copyObjects, ObjectStore } from "./objects.js";
import { HubStore } from "./hub.js";
import {
  protocolVersion,
  type ConflictRecord,
  type HubCheckpoint,
  type HubConfig,
  type ProductConfig,
  type SignedAdoptionVerification,
  type SignedConflict,
  type SignedSnapshot,
} from "./types.js";

const maxHeaderBytes = 256 * 1024 * 1024;
const maxPayloadBytes = 512 * 1024 * 1024;
const transferBatchBytes = 8 * 1024 * 1024;
const transferBatchObjects = 256;

interface Frame {
  readonly header: Record<string, unknown>;
  readonly payload: Buffer;
}

interface TransferEntry {
  readonly id: string;
  readonly offset: number;
  readonly bytes: number;
}

export class HubTransport implements AsyncDisposable {
  private constructor(
    private readonly local: HubStore | null,
    private readonly client: FramedClient | null,
    private readonly child: ChildProcessWithoutNullStreams | null,
  ) {}

  public static async connect(config: HubConfig): Promise<HubTransport> {
    if (config.kind === "local") {
      const transport = new HubTransport(new HubStore(config.path), null, null);
      if ((await transport.hello()) !== protocolVersion)
        throw new Error("V3 protocol mismatch");
      return transport;
    }
    const encoded = Buffer.from(config.path, "utf8").toString("base64url");
    const child = spawn(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        config.host,
        ...config.command,
        "hub",
        "serve",
        "--stdio",
        "--hub-base64",
        encoded,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const client = new FramedClient(child.stdout, child.stdin);
    const transport = new HubTransport(null, client, child);
    if ((await transport.hello()) !== protocolVersion) {
      await transport[Symbol.asyncDispose]();
      throw new Error("V3 protocol mismatch");
    }
    return transport;
  }

  /** Process-isolated transport for integration tests and local harnesses. */
  public static async connectProcess(
    command: string,
    args: readonly string[],
  ): Promise<HubTransport> {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const transport = new HubTransport(
      null,
      new FramedClient(child.stdout, child.stdin),
      child,
    );
    if ((await transport.hello()) !== protocolVersion) {
      await transport[Symbol.asyncDispose]();
      throw new Error("V3 protocol mismatch");
    }
    return transport;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.local?.[Symbol.dispose]();
    if (this.child !== null) {
      this.child.stdin.end();
      if (this.child.exitCode === null) this.child.kill("SIGTERM");
    }
  }

  public async hello(): Promise<number> {
    return this.local?.hello() ?? Number(await this.call("hello", {}));
  }

  public async createFolder(config: ProductConfig): Promise<void> {
    if (this.local !== null) this.local.createFolder(config);
    else await this.call("create-folder", { config });
  }

  public async checkpoint(folderId: string): Promise<HubCheckpoint> {
    return (
      this.local?.checkpoint(folderId) ??
      ((await this.call("checkpoint", { folderId })) as HubCheckpoint)
    );
  }

  public async updateConfig(
    config: ProductConfig,
    expectedRevision: number,
  ): Promise<ProductConfig> {
    return (
      this.local?.updateConfig(config, expectedRevision) ??
      ((await this.call("update-config", {
        config,
        expectedRevision,
      })) as ProductConfig)
    );
  }

  public async ensureHubObjects(
    ids: readonly string[],
    source: ObjectStore,
  ): Promise<number> {
    if (this.local !== null)
      return copyObjects(ids, source, this.local.objects);
    const missing = (await this.call("missing-objects", { ids })) as string[];
    let copied = 0;
    for (let offset = 0; offset < missing.length;) {
      const entries: TransferEntry[] = [];
      const buffers: Buffer[] = [];
      let payloadBytes = 0;
      while (offset < missing.length && entries.length < transferBatchObjects) {
        const id = missing[offset];
        if (id === undefined) break;
        const bytes = source.get(id);
        if (
          entries.length > 0 &&
          payloadBytes + bytes.length > transferBatchBytes
        )
          break;
        entries.push({ id, offset: payloadBytes, bytes: bytes.length });
        buffers.push(bytes);
        payloadBytes += bytes.length;
        offset += 1;
      }
      await this.call("put-objects", { entries }, Buffer.concat(buffers));
      copied += entries.length;
    }
    return copied;
  }

  public async fetchObjects(
    ids: readonly string[],
    destination: ObjectStore,
  ): Promise<number> {
    const missing = ids.filter((id) => !destination.has(id));
    if (this.local !== null)
      return copyObjects(missing, this.local.objects, destination);
    let copied = 0;
    for (
      let offset = 0;
      offset < missing.length;
      offset += transferBatchObjects
    ) {
      const batch = missing.slice(offset, offset + transferBatchObjects);
      const frame = await this.callFrame("get-objects", { ids: batch });
      const entries = parseEntries(frame.header.entries);
      destination.batch(() => {
        for (const entry of entries) {
          const end = entry.offset + entry.bytes;
          if (end > frame.payload.length)
            throw new Error("Object transfer entry escapes payload");
          destination.put(
            Buffer.from(frame.payload.subarray(entry.offset, end)),
            entry.id,
          );
          copied += 1;
        }
      });
    }
    return copied;
  }

  public async acceptSnapshot(input: SignedSnapshot): Promise<number> {
    return (
      this.local?.acceptSnapshot(input) ??
      Number(await this.call("accept-snapshot", { input }))
    );
  }

  public async addConflict(input: SignedConflict): Promise<void> {
    if (this.local !== null) this.local.addConflict(input);
    else await this.call("add-conflict", { input });
  }

  public async conflicts(folderId: string): Promise<readonly ConflictRecord[]> {
    return (
      this.local?.conflicts(folderId) ??
      ((await this.call("conflicts", { folderId })) as ConflictRecord[])
    );
  }

  public async recordAdoptionVerification(
    input: SignedAdoptionVerification,
  ): Promise<void> {
    if (this.local !== null) this.local.recordAdoptionVerification(input);
    else await this.call("verify-adoption", { input });
  }

  public async verifiedAdoptionPeers(
    folderId: string,
  ): Promise<readonly string[]> {
    return (
      this.local?.verifiedAdoptionPeers(folderId) ??
      ((await this.call("verified-adoption-peers", { folderId })) as string[])
    );
  }

  public async history(
    folderId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return (
      this.local?.history(folderId) ??
      ((await this.call("history", { folderId })) as Record<string, unknown>[])
    );
  }

  private async call(
    operation: string,
    args: Record<string, unknown>,
    payload = Buffer.alloc(0),
  ): Promise<unknown> {
    const frame = await this.callFrame(operation, args, payload);
    return frame.header.value;
  }

  private async callFrame(
    operation: string,
    args: Record<string, unknown>,
    payload = Buffer.alloc(0),
  ): Promise<Frame> {
    if (this.client === null) throw new Error("Remote client is unavailable");
    return this.client.request(operation, args, payload);
  }
}

export async function serveHubStdio(hubPath: string): Promise<void> {
  using hub = new HubStore(hubPath);
  const reader = new FrameReader(process.stdin);
  for (;;) {
    const frame = await reader.read();
    if (frame === null) return;
    const id = number(frame.header.id, "Request ID");
    try {
      const operation = string(frame.header.operation, "Operation");
      const args = record(frame.header.args, "Arguments");
      const result = handleRequest(hub, operation, args, frame.payload);
      await writeFrame(process.stdout, {
        header: { id, ok: true, ...result.header },
        payload: result.payload,
      });
    } catch (error) {
      await writeFrame(process.stdout, {
        header: {
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        payload: Buffer.alloc(0),
      });
    }
  }
}

function handleRequest(
  hub: HubStore,
  operation: string,
  args: Record<string, unknown>,
  payload: Buffer,
): { readonly header: Record<string, unknown>; readonly payload: Buffer } {
  const value = (result: unknown) => ({
    header: { value: result },
    payload: Buffer.alloc(0),
  });
  switch (operation) {
    case "hello":
      return value(hub.hello());
    case "create-folder":
      hub.createFolder(args.config as ProductConfig);
      return value(null);
    case "checkpoint":
      return value(hub.checkpoint(string(args.folderId, "Folder ID")));
    case "update-config":
      return value(
        hub.updateConfig(
          args.config as ProductConfig,
          number(args.expectedRevision, "Expected revision"),
        ),
      );
    case "missing-objects": {
      const ids = stringArray(args.ids, "Object IDs");
      return value(ids.filter((id) => !hub.objects.has(id)));
    }
    case "put-objects": {
      const entries = parseEntries(args.entries);
      hub.objects.batch(() => {
        for (const entry of entries) {
          const end = entry.offset + entry.bytes;
          if (end > payload.length)
            throw new Error("Object transfer entry escapes payload");
          hub.objects.put(
            Buffer.from(payload.subarray(entry.offset, end)),
            entry.id,
          );
        }
      });
      return value(entries.length);
    }
    case "get-objects": {
      const ids = stringArray(args.ids, "Object IDs");
      const entries: TransferEntry[] = [];
      const buffers: Buffer[] = [];
      let offset = 0;
      for (const id of ids) {
        const bytes = hub.objects.get(id);
        entries.push({ id, offset, bytes: bytes.length });
        buffers.push(bytes);
        offset += bytes.length;
      }
      return {
        header: { entries },
        payload: Buffer.concat(buffers),
      };
    }
    case "accept-snapshot":
      return value(hub.acceptSnapshot(args.input as SignedSnapshot));
    case "add-conflict":
      hub.addConflict(args.input as SignedConflict);
      return value(null);
    case "conflicts":
      return value(hub.conflicts(string(args.folderId, "Folder ID")));
    case "verify-adoption":
      hub.recordAdoptionVerification(args.input as SignedAdoptionVerification);
      return value(null);
    case "verified-adoption-peers":
      return value(
        hub.verifiedAdoptionPeers(string(args.folderId, "Folder ID")),
      );
    case "history":
      return value(hub.history(string(args.folderId, "Folder ID")));
    default:
      throw new Error(`Unknown V3 hub operation: ${operation}`);
  }
}

class FramedClient {
  private readonly reader: FrameReader;
  private nextId = 1;
  private queue = Promise.resolve();

  public constructor(
    readable: Readable,
    private readonly writable: Writable,
  ) {
    this.reader = new FrameReader(readable);
  }

  public request(
    operation: string,
    args: Record<string, unknown>,
    payload: Buffer,
  ): Promise<Frame> {
    const id = this.nextId++;
    const run = async () => {
      await writeFrame(this.writable, {
        header: { id, operation, args },
        payload,
      });
      const response = await this.reader.read();
      if (response === null) throw new Error("Hub closed before responding");
      if (number(response.header.id, "Response ID") !== id)
        throw new Error("Hub response ID mismatch");
      if (response.header.ok !== true)
        throw new Error(String(response.header.error ?? "Hub request failed"));
      return response;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class FrameReader {
  private buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<unknown>;

  public constructor(readable: Readable) {
    this.iterator = readable[Symbol.asyncIterator]();
  }

  public async read(): Promise<Frame | null> {
    while (this.buffer.length < 8) if (!(await this.more())) return null;
    const headerBytes = this.buffer.readUInt32BE(0);
    const payloadBytes = this.buffer.readUInt32BE(4);
    if (headerBytes > maxHeaderBytes || payloadBytes > maxPayloadBytes)
      throw new Error("Frame exceeds V3 protocol bounds");
    const total = 8 + headerBytes + payloadBytes;
    while (this.buffer.length < total)
      if (!(await this.more())) throw new Error("Truncated V3 frame");
    const header = JSON.parse(
      this.buffer.subarray(8, 8 + headerBytes).toString("utf8"),
    ) as unknown;
    const frame = {
      header: record(header, "Frame header"),
      payload: Buffer.from(this.buffer.subarray(8 + headerBytes, total)),
    };
    this.buffer = this.buffer.subarray(total);
    return frame;
  }

  private async more(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) return false;
    if (!(next.value instanceof Uint8Array))
      throw new Error("Frame stream produced a non-byte chunk");
    this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    return true;
  }
}

async function writeFrame(writable: Writable, frame: Frame): Promise<void> {
  const header = Buffer.from(JSON.stringify(frame.header), "utf8");
  if (header.length > maxHeaderBytes || frame.payload.length > maxPayloadBytes)
    throw new Error("Frame exceeds V3 protocol bounds");
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(header.length, 0);
  prefix.writeUInt32BE(frame.payload.length, 4);
  const bytes = Buffer.concat([prefix, header, frame.payload]);
  await new Promise<void>((resolve, reject) =>
    writable.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}

function parseEntries(value: unknown): TransferEntry[] {
  if (!Array.isArray(value)) throw new Error("Transfer entries are invalid");
  return value.map((item) => {
    const input = record(item, "Transfer entry");
    return {
      id: string(input.id, "Object ID"),
      offset: number(input.offset, "Object offset"),
      bytes: number(input.bytes, "Object bytes"),
    };
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => string(item, label));
}
