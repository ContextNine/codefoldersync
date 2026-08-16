import { spawnSync } from "node:child_process";
import { parseFolderRecord, parseHubResponse, parseSnapshot } from "./codec.js";
import { handleHubRequest } from "./hub.js";
import {
  type FolderRecord,
  type HubCommitResponse,
  type HubConfig,
  type HubRequest,
  type Snapshot,
} from "./types.js";

export class HubTransport {
  public constructor(private readonly config: HubConfig) {}

  public createFolder(folder: FolderRecord): FolderRecord {
    return parseFolderRecord(this.request({ type: "create-folder", folder }));
  }

  public getFolder(folderId: string): FolderRecord {
    return parseFolderRecord(this.request({ type: "get-folder", folderId }));
  }

  public getFolderState(folderId: string): {
    readonly folder: FolderRecord;
    readonly units: Readonly<
      Record<
        string,
        { readonly head: string | null; readonly snapshot: Snapshot | null }
      >
    >;
  } {
    const value = record(
      this.request({ type: "get-folder-state", folderId }),
      "Folder state",
    );
    const unitsValue = record(value.units, "Folder units");
    const units: Record<
      string,
      { readonly head: string | null; readonly snapshot: Snapshot | null }
    > = {};
    for (const [unit, raw] of Object.entries(unitsValue)) {
      const entry = record(raw, `Unit ${unit}`);
      if (entry.head !== null && typeof entry.head !== "string") {
        throw new Error(`Invalid head for ${unit}`);
      }
      units[unit] = {
        head: entry.head,
        snapshot:
          entry.snapshot === null ? null : parseSnapshot(entry.snapshot),
      };
    }
    return { folder: parseFolderRecord(value.folder), units };
  }

  public getUnit(
    folderId: string,
    unit: string,
  ): { readonly head: string | null; readonly snapshot: Snapshot | null } {
    const value = record(
      this.request({ type: "get-unit", folderId, unit }),
      "Unit",
    );
    const head = value.head;
    if (head !== null && typeof head !== "string")
      throw new Error("Invalid unit head");
    return {
      head,
      snapshot: value.snapshot === null ? null : parseSnapshot(value.snapshot),
    };
  }

  public getSnapshot(folderId: string, snapshotId: string): Snapshot {
    return parseSnapshot(
      this.request({ type: "get-snapshot", folderId, snapshotId }),
    );
  }

  public commit(
    folderId: string,
    expectedHead: string | null,
    snapshot: Snapshot,
  ): HubCommitResponse {
    const value = record(
      this.request({ type: "commit", folderId, expectedHead, snapshot }),
      "Commit response",
    );
    if (
      typeof value.committed !== "boolean" ||
      (value.currentHead !== null && typeof value.currentHead !== "string") ||
      typeof value.snapshotId !== "string"
    ) {
      throw new Error("Invalid commit response");
    }
    return {
      committed: value.committed,
      currentHead: value.currentHead,
      snapshotId: value.snapshotId,
    };
  }

  public preserveConflict(
    folderId: string,
    remoteHead: string,
    snapshot: Snapshot,
  ): void {
    this.request({ type: "preserve-conflict", folderId, remoteHead, snapshot });
  }

  public history(folderId: string, unit: string): readonly Snapshot[] {
    const value = this.request({ type: "history", folderId, unit });
    if (!Array.isArray(value))
      throw new Error("History response must be an array");
    return value.map(parseSnapshot);
  }

  private request(request: HubRequest): unknown {
    if (this.config.kind === "local") {
      return handleHubRequest(this.config.path, request);
    }
    const hubPath = Buffer.from(this.config.path, "utf8").toString("base64url");
    const result = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        this.config.host,
        ...this.config.command,
        "hub-rpc",
        "--hub-base64",
        hubPath,
      ],
      {
        input: `${JSON.stringify(request)}\n`,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    let response;
    try {
      response = parseHubResponse(JSON.parse(result.stdout) as unknown);
    } catch {
      const detail =
        result.stderr.trim() || `ssh exited ${String(result.status)}`;
      throw new Error(`Hub SSH request failed: ${detail}`);
    }
    if (!response.ok) throw new Error(response.error);
    if (result.status !== 0) {
      throw new Error(`Hub SSH request exited ${String(result.status)}`);
    }
    return response.value;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
