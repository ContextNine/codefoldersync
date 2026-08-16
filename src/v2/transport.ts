import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { HubStore } from "./hub.js";
import { decodeTransfer, encodeTransfer, ObjectStore } from "./objects.js";
import {
  protocolVersion,
  type Checkpoint,
  type ChangeBatch,
  type ConflictRecord,
  type EventRequest,
  type EventResult,
  type FolderRecord,
  type HubConfig,
  type ObjectEncoding,
} from "./types.js";

interface FrameHeader {
  readonly id: number;
  readonly op?: string;
  readonly args?: unknown;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

interface Frame {
  readonly header: FrameHeader;
  readonly payload: Buffer;
}

interface TransferEntry {
  readonly id: string;
  readonly encoding: ObjectEncoding;
  readonly offset: number;
  readonly bytes: number;
}

const maximumUploadEntries = 4_096;
const maximumUploadBytes = 8 * 1024 * 1024;

export interface TransferStats {
  readonly objects: number;
  readonly bytes: number;
}

export interface PublishExchange {
  readonly results: readonly EventResult[];
  readonly changes: ChangeBatch;
  readonly conflicts: readonly ConflictRecord[];
  readonly transfer: TransferStats;
}

export class HubTransport implements AsyncDisposable {
  private readonly local: HubStore | null;
  private readonly remote: FramedClient | null;

  private constructor(local: HubStore | null, remote: FramedClient | null) {
    this.local = local;
    this.remote = remote;
  }

  public static async connect(config: HubConfig): Promise<HubTransport> {
    if (config.kind === "local") {
      return new HubTransport(new HubStore(config.path), null);
    }
    const encodedPath = Buffer.from(config.path, "utf8").toString("base64url");
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
        encodedPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const client = new FramedClient(child);
    const hello = record(await client.request("hello", {}), "Hub hello");
    if (hello.protocolVersion !== protocolVersion) {
      await client.close();
      throw new Error(
        `Hub protocol mismatch: expected ${protocolVersion}, received ${String(hello.protocolVersion)}`,
      );
    }
    return new HubTransport(null, client);
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.local !== null) this.local[Symbol.dispose]();
    if (this.remote !== null) await this.remote.close();
  }

  public async createFolder(folder: FolderRecord): Promise<FolderRecord> {
    if (this.local !== null) return this.local.createFolder(folder);
    return (await this.requiredRemote().request(
      "create-folder",
      folder,
    )) as FolderRecord;
  }

  public async getFolder(folderId: string): Promise<FolderRecord> {
    if (this.local !== null) return this.local.getFolder(folderId);
    return (await this.requiredRemote().request("get-folder", {
      folderId,
    })) as FolderRecord;
  }

  public async updateRepositories(
    folderId: string,
    expected: readonly string[],
    repositories: FolderRecord["repositories"],
  ): Promise<FolderRecord> {
    if (this.local !== null)
      return this.local.updateRepositories(folderId, expected, repositories);
    return (await this.requiredRemote().request("update-repositories", {
      folderId,
      expected,
      repositories,
    })) as FolderRecord;
  }

  public async updateIgnorePatterns(
    folderId: string,
    expected: readonly string[],
    patterns: readonly string[],
  ): Promise<FolderRecord> {
    if (this.local !== null)
      return this.local.updateIgnorePatterns(folderId, expected, patterns);
    return (await this.requiredRemote().request("update-ignore", {
      folderId,
      expected,
      patterns,
    })) as FolderRecord;
  }

  public async checkpoint(folderId: string): Promise<Checkpoint> {
    if (this.local !== null) return this.local.checkpoint(folderId);
    const frame = await this.requiredRemote().requestFrame("checkpoint", {
      folderId,
    });
    const value = record(frame.header.value, "Checkpoint response");
    const encoding = value.encoding;
    if (encoding !== "raw" && encoding !== "brotli")
      throw new Error("Checkpoint encoding is invalid");
    return JSON.parse(
      decodeTransfer(encoding, frame.payload).toString("utf8"),
    ) as Checkpoint;
  }

  public async sequence(folderId: string): Promise<number> {
    if (this.local !== null) return this.local.sequence(folderId);
    const value = record(
      await this.requiredRemote().request("sequence", { folderId }),
      "Hub sequence",
    );
    if (
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence)
    )
      throw new Error("Hub sequence is invalid");
    return value.sequence;
  }

  public async pushObjects(
    ids: readonly string[],
    source: ObjectStore,
  ): Promise<TransferStats> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { objects: 0, bytes: 0 };
    const missing = await this.missingObjects(unique);
    if (this.local !== null) {
      let bytes = 0;
      this.local.objects.batch(() => {
        for (const id of missing) {
          const value = source.get(id);
          this.local?.objects.put(value, id);
          bytes += value.length;
        }
      });
      return { objects: missing.length, bytes };
    }
    let objects = 0;
    let bytes = 0;
    let batch: { readonly entry: TransferEntry; readonly payload: Buffer }[] =
      [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const payload = Buffer.concat(
        batch.map((item) => item.payload),
        batchBytes,
      );
      await this.requiredRemote().request(
        "put-objects",
        { entries: batch.map((item) => item.entry) },
        payload,
      );
      objects += batch.length;
      bytes += payload.length;
      batch = [];
      batchBytes = 0;
    };
    for (const id of missing) {
      const encoded = encodeTransfer(source.get(id));
      if (
        batch.length >= maximumUploadEntries ||
        batchBytes + encoded.payload.length > maximumUploadBytes
      )
        await flush();
      const entry: TransferEntry = {
        id,
        encoding: encoded.encoding,
        offset: batchBytes,
        bytes: encoded.payload.length,
      };
      batch.push({ entry, payload: encoded.payload });
      batchBytes += encoded.payload.length;
    }
    await flush();
    return { objects, bytes };
  }

  public async pullObjects(
    ids: readonly string[],
    destination: ObjectStore,
  ): Promise<TransferStats> {
    const missing = [...new Set(ids)].filter((id) => !destination.has(id));
    if (this.local !== null) {
      let bytes = 0;
      destination.batch(() => {
        for (const id of missing) {
          const value = this.local?.objects.get(id);
          if (value === undefined) throw new Error(`Missing object: ${id}`);
          destination.put(value, id);
          bytes += value.length;
        }
      });
      return { objects: missing.length, bytes };
    }
    let objects = 0;
    let bytes = 0;
    for (let offset = 0; offset < missing.length; offset += 256) {
      const batch = missing.slice(offset, offset + 256);
      const response = await this.requiredRemote().requestFrame("get-objects", {
        ids: batch,
      });
      const value = record(response.header.value, "Object response");
      if (!Array.isArray(value.entries))
        throw new Error("Object entries are invalid");
      const entries = value.entries.map(parseTransferEntry);
      destination.batch(() => {
        for (const entry of entries) {
          const payload = response.payload.subarray(
            entry.offset,
            entry.offset + entry.bytes,
          );
          if (payload.length !== entry.bytes)
            throw new Error("Truncated object payload");
          destination.put(decodeTransfer(entry.encoding, payload), entry.id);
        }
      });
      objects += entries.length;
      bytes += response.payload.length;
    }
    return { objects, bytes };
  }

  public async submitMany(
    events: readonly EventRequest[],
  ): Promise<readonly EventResult[]> {
    if (this.local !== null) return this.local.submitMany(events);
    return (await this.requiredRemote().request("submit-many", {
      events,
    })) as EventResult[];
  }

  /**
   * Publishes a bounded incremental event and its new objects in one hub
   * exchange. Objects too large for the final frame are durably pre-staged;
   * retries remain safe because objects and events are immutable/idempotent.
   */
  public async publish(
    folderId: string,
    after: number,
    events: readonly EventRequest[],
    ids: readonly string[],
    source: ObjectStore,
  ): Promise<PublishExchange> {
    const unique = [...new Set(ids)];
    if (this.local !== null) {
      let bytes = 0;
      this.local.objects.batch(() => {
        for (const id of unique) {
          const value = source.get(id);
          this.local?.objects.put(value, id);
          bytes += value.length;
        }
      });
      const results = this.local.submitMany(events);
      return {
        results,
        changes: this.local.changes(folderId, after),
        conflicts: this.local.conflicts(folderId),
        transfer: { objects: unique.length, bytes },
      };
    }

    const batches = transferBatches(unique, source);
    let objects = 0;
    let bytes = 0;
    while (batches.length > 1) {
      const batch = batches.shift();
      if (batch === undefined) break;
      await this.requiredRemote().request(
        "put-objects",
        { entries: batch.entries },
        batch.payload,
      );
      objects += batch.entries.length;
      bytes += batch.payload.length;
    }
    const final = batches[0] ?? { entries: [], payload: Buffer.alloc(0) };
    const value = record(
      await this.requiredRemote().request(
        "publish",
        { folderId, after, events, entries: final.entries },
        final.payload,
      ),
      "Publish response",
    );
    if (
      !Array.isArray(value.results) ||
      value.changes === null ||
      typeof value.changes !== "object" ||
      Array.isArray(value.changes) ||
      !Array.isArray(value.conflicts)
    )
      throw new Error("Publish response is invalid");
    return {
      results: value.results as EventResult[],
      changes: value.changes as unknown as ChangeBatch,
      conflicts: value.conflicts as ConflictRecord[],
      transfer: {
        objects: objects + final.entries.length,
        bytes: bytes + final.payload.length,
      },
    };
  }

  public async conflicts(folderId: string): Promise<readonly ConflictRecord[]> {
    if (this.local !== null) return this.local.conflicts(folderId);
    return (await this.requiredRemote().request("conflicts", {
      folderId,
    })) as ConflictRecord[];
  }

  public async resolveConflict(
    folderId: string,
    conflictId: string,
    resolution: "canonical" | "conflict" | "filesystem",
  ): Promise<ConflictRecord> {
    if (this.local !== null)
      return this.local.resolveConflict(folderId, conflictId, resolution);
    return (await this.requiredRemote().request("resolve-conflict", {
      folderId,
      conflictId,
      resolution,
    })) as ConflictRecord;
  }

  public async changes(folderId: string, after: number): Promise<ChangeBatch> {
    if (this.local !== null) return this.local.changes(folderId, after);
    return (await this.requiredRemote().request("changes", {
      folderId,
      after,
    })) as ChangeBatch;
  }

  public async history(
    folderId: string,
    repository?: string,
  ): Promise<
    readonly { readonly event: EventRequest; readonly result: EventResult }[]
  > {
    if (this.local !== null) return this.local.history(folderId, repository);
    return (await this.requiredRemote().request("history", {
      folderId,
      repository,
    })) as {
      readonly event: EventRequest;
      readonly result: EventResult;
    }[];
  }

  public async gcDryRun(): Promise<{
    readonly totalObjects: number;
    readonly reachableObjects: number;
    readonly unreachableObjects: number;
    readonly unreachableBytes: number;
    readonly unreachableIds: readonly string[];
    readonly automaticDeletion: false;
  }> {
    if (this.local !== null) return this.local.gcDryRun();
    return (await this.requiredRemote().request("gc-dry-run", {})) as Awaited<
      ReturnType<HubTransport["gcDryRun"]>
    >;
  }

  private async missingObjects(
    ids: readonly string[],
  ): Promise<readonly string[]> {
    if (this.local !== null) return this.local.hasObjects(ids);
    return (await this.requiredRemote().request("has-objects", {
      ids,
    })) as string[];
  }

  private requiredRemote(): FramedClient {
    if (this.remote === null)
      throw new Error("Remote transport is unavailable");
    return this.remote;
  }
}

export async function serveHubStdio(hubPath: string): Promise<void> {
  using hub = new HubStore(hubPath);
  const reader = new FrameReader(process.stdin);
  for (;;) {
    const frame = await reader.read();
    if (frame === null) return;
    try {
      const op = frame.header.op;
      if (typeof op !== "string")
        throw new Error("Request operation is missing");
      const response = handleRequest(hub, op, frame.header.args, frame.payload);
      await writeFrame(
        process.stdout,
        {
          id: frame.header.id,
          ok: true,
          value: response.value,
        },
        response.payload,
      );
    } catch (error) {
      await writeFrame(process.stdout, {
        id: frame.header.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function handleRequest(
  hub: HubStore,
  op: string,
  rawArgs: unknown,
  payload: Buffer,
): { readonly value: unknown; readonly payload?: Buffer } {
  const args = record(rawArgs, `${op} arguments`);
  switch (op) {
    case "hello":
      return { value: { protocolVersion } };
    case "create-folder":
      return { value: hub.createFolder(rawArgs as FolderRecord) };
    case "get-folder":
      return {
        value: hub.getFolder(requiredString(args.folderId, "Folder ID")),
      };
    case "update-repositories": {
      if (!Array.isArray(args.repositories))
        throw new Error("Repositories are invalid");
      return {
        value: hub.updateRepositories(
          requiredString(args.folderId, "Folder ID"),
          stringArray(args.expected, "Expected repositories"),
          args.repositories as FolderRecord["repositories"],
        ),
      };
    }
    case "update-ignore":
      return {
        value: hub.updateIgnorePatterns(
          requiredString(args.folderId, "Folder ID"),
          stringArray(args.expected, "Expected ignore patterns"),
          stringArray(args.patterns, "Ignore patterns"),
        ),
      };
    case "checkpoint": {
      const checkpoint = Buffer.from(
        JSON.stringify(
          hub.checkpoint(requiredString(args.folderId, "Folder ID")),
        ),
        "utf8",
      );
      const encoded = encodeTransfer(checkpoint);
      return {
        value: { encoding: encoded.encoding },
        payload: encoded.payload,
      };
    }
    case "sequence":
      return {
        value: {
          sequence: hub.sequence(requiredString(args.folderId, "Folder ID")),
        },
      };
    case "has-objects": {
      const ids = stringArray(args.ids, "Object IDs");
      return { value: hub.hasObjects(ids) };
    }
    case "put-objects": {
      if (!Array.isArray(args.entries))
        throw new Error("Transfer entries are invalid");
      const entries = args.entries.map(parseTransferEntry);
      hub.objects.batch(() => {
        for (const entry of entries) {
          const encoded = payload.subarray(
            entry.offset,
            entry.offset + entry.bytes,
          );
          if (encoded.length !== entry.bytes)
            throw new Error("Truncated uploaded object");
          hub.objects.put(decodeTransfer(entry.encoding, encoded), entry.id);
        }
      });
      return { value: { stored: entries.length } };
    }
    case "publish": {
      if (!Array.isArray(args.entries) || !Array.isArray(args.events))
        throw new Error("Publish payload is invalid");
      const entries = args.entries.map(parseTransferEntry);
      hub.objects.batch(() => {
        for (const entry of entries) {
          const encoded = payload.subarray(
            entry.offset,
            entry.offset + entry.bytes,
          );
          if (encoded.length !== entry.bytes)
            throw new Error("Truncated published object");
          hub.objects.put(decodeTransfer(entry.encoding, encoded), entry.id);
        }
      });
      const folderId = requiredString(args.folderId, "Folder ID");
      const events = args.events as EventRequest[];
      if (events.some((event) => event.folderId !== folderId))
        throw new Error("Published event folder mismatch");
      return {
        value: {
          results: hub.submitMany(events),
          changes: hub.changes(
            folderId,
            nonNegativeInteger(args.after, "Change cursor"),
          ),
          conflicts: hub.conflicts(folderId),
        },
      };
    }
    case "get-objects": {
      const ids = stringArray(args.ids, "Object IDs");
      const entries: TransferEntry[] = [];
      const payloads: Buffer[] = [];
      let offset = 0;
      for (const id of ids) {
        const encoded = encodeTransfer(hub.objects.get(id));
        entries.push({
          id,
          encoding: encoded.encoding,
          offset,
          bytes: encoded.payload.length,
        });
        payloads.push(encoded.payload);
        offset += encoded.payload.length;
      }
      return { value: { entries }, payload: Buffer.concat(payloads, offset) };
    }
    case "submit-many": {
      if (!Array.isArray(args.events)) throw new Error("Events are invalid");
      return { value: hub.submitMany(args.events as EventRequest[]) };
    }
    case "conflicts":
      return {
        value: hub.conflicts(requiredString(args.folderId, "Folder ID")),
      };
    case "resolve-conflict": {
      const resolution = args.resolution;
      if (
        resolution !== "canonical" &&
        resolution !== "conflict" &&
        resolution !== "filesystem"
      ) {
        throw new Error("Conflict resolution is invalid");
      }
      return {
        value: hub.resolveConflict(
          requiredString(args.folderId, "Folder ID"),
          requiredString(args.conflictId, "Conflict ID"),
          resolution,
        ),
      };
    }
    case "changes":
      return {
        value: hub.changes(
          requiredString(args.folderId, "Folder ID"),
          nonNegativeInteger(args.after, "Change cursor"),
        ),
      };
    case "history":
      return {
        value: hub.history(
          requiredString(args.folderId, "Folder ID"),
          optionalString(args.repository, "Repository"),
        ),
      };
    case "gc-dry-run":
      return { value: hub.gcDryRun() };
    default:
      throw new Error(`Unknown hub operation: ${op}`);
  }
}

class FramedClient {
  private readonly reader: FrameReader;
  private readonly stderr: string[] = [];
  private requestId = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.reader = new FrameReader(child.stdout);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr.push(chunk);
      if (this.stderr.join("").length > 16_384) this.stderr.shift();
    });
  }

  public async request(
    op: string,
    args: unknown,
    payload?: Buffer,
  ): Promise<unknown> {
    return (await this.requestFrame(op, args, payload)).header.value;
  }

  public async requestFrame(
    op: string,
    args: unknown,
    payload: Buffer = Buffer.alloc(0),
  ): Promise<Frame> {
    const task = this.chain.then(() => this.perform(op, args, payload));
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      await Promise.race([once(this.child, "exit"), delay(2000)]);
    }
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  private async perform(
    op: string,
    args: unknown,
    payload: Buffer,
  ): Promise<Frame> {
    if (this.closed) throw new Error("Hub connection is closed");
    const id = (this.requestId += 1);
    await writeFrame(this.child.stdin, { id, op, args }, payload);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Hub request timed out: ${op}`)),
        120_000,
      );
      timeout.unref();
    });
    let frame: Frame | null;
    try {
      frame = await Promise.race([this.reader.read(), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (frame === null) {
      throw new Error(
        `Hub SSH connection closed: ${this.stderr.join("").trim() || "no stderr"}`,
      );
    }
    if (frame.header.id !== id) throw new Error("Hub response ID mismatch");
    if (frame.header.ok !== true)
      throw new Error(frame.header.error ?? `Hub request failed: ${op}`);
    return frame;
  }
}

class FrameReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private readonly waiting: (() => void)[] = [];

  public constructor(stream: Readable) {
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, bytes]);
      this.wake();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("error", () => {
      this.ended = true;
      this.wake();
    });
  }

  public async read(): Promise<Frame | null> {
    while (this.buffer.length < 8) {
      if (this.ended)
        return this.buffer.length === 0 ? null : fail("Truncated frame prefix");
      await this.wait();
    }
    const headerBytes = this.buffer.readUInt32BE(0);
    const payloadBytes = this.buffer.readUInt32BE(4);
    if (headerBytes > 16 * 1024 * 1024 || payloadBytes > 512 * 1024 * 1024)
      throw new Error("Frame exceeds protocol limit");
    const total = 8 + headerBytes + payloadBytes;
    while (this.buffer.length < total) {
      if (this.ended) return fail("Truncated frame");
      await this.wait();
    }
    const header = JSON.parse(
      this.buffer.subarray(8, 8 + headerBytes).toString("utf8"),
    ) as FrameHeader;
    const payload = Buffer.from(this.buffer.subarray(8 + headerBytes, total));
    this.buffer = this.buffer.subarray(total);
    return { header, payload };
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

async function writeFrame(
  stream: Writable,
  header: FrameHeader,
  payload: Buffer = Buffer.alloc(0),
): Promise<void> {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(headerBytes.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  if (!stream.write(prefix)) await once(stream, "drain");
  if (!stream.write(headerBytes)) await once(stream, "drain");
  if (payload.length > 0 && !stream.write(payload)) await once(stream, "drain");
}

function parseTransferEntry(value: unknown): TransferEntry {
  const input = record(value, "Transfer entry");
  const encoding = input.encoding;
  if (encoding !== "raw" && encoding !== "brotli")
    throw new Error("Transfer encoding is invalid");
  return {
    id: requiredString(input.id, "Object ID"),
    encoding,
    offset: nonNegativeInteger(input.offset, "Object offset"),
    bytes: nonNegativeInteger(input.bytes, "Object bytes"),
  };
}

function transferBatches(
  ids: readonly string[],
  source: ObjectStore,
): { readonly entries: readonly TransferEntry[]; readonly payload: Buffer }[] {
  const batches: {
    entries: TransferEntry[];
    payloads: Buffer[];
    bytes: number;
  }[] = [];
  let batch = {
    entries: [] as TransferEntry[],
    payloads: [] as Buffer[],
    bytes: 0,
  };
  const flush = () => {
    if (batch.entries.length === 0) return;
    batches.push(batch);
    batch = { entries: [], payloads: [], bytes: 0 };
  };
  for (const id of ids) {
    const encoded = encodeTransfer(source.get(id));
    if (
      batch.entries.length >= maximumUploadEntries ||
      batch.bytes + encoded.payload.length > maximumUploadBytes
    )
      flush();
    batch.entries.push({
      id,
      encoding: encoded.encoding,
      offset: batch.bytes,
      bytes: encoded.payload.length,
    });
    batch.payloads.push(encoded.payload);
    batch.bytes += encoded.payload.length;
  }
  flush();
  return batches.map((value) => ({
    entries: value.entries,
    payload: Buffer.concat(value.payloads, value.bytes),
  }));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label} must be an array of strings`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
