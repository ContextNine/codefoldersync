import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConflictRecord,
  EventRequest,
  EventResult,
  GitStateRecord,
  LocalEntry,
  ProductConfig,
} from "./types.js";

interface OutboxRecord {
  readonly event: EventRequest;
  readonly objectIds: readonly string[];
}

export class LocalState implements Disposable {
  private readonly database: DatabaseSync;

  public constructor(config: ProductConfig) {
    const path = join(config.stateDir, "state.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_entries (
        repository TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        entry_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        manifest_id TEXT,
        content_version TEXT NOT NULL,
        device INTEGER,
        inode INTEGER,
        observed_size INTEGER,
        observed_mtime_ms REAL,
        observed_ctime_ms REAL,
        observed_mode INTEGER,
        PRIMARY KEY (repository, path),
        UNIQUE (repository, node_id)
      );
      CREATE INDEX IF NOT EXISTS local_entries_parent
        ON local_entries(repository, parent_node_id, name);
      CREATE INDEX IF NOT EXISTS local_entries_identity
        ON local_entries(repository, device, inode);
      CREATE TABLE IF NOT EXISTS local_git (
        repository TEXT PRIMARY KEY,
        version TEXT,
        manifest_id TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        peer_sequence INTEGER NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        object_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apply_journal (
        transaction_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.initialize(config);
  }

  public [Symbol.dispose](): void {
    this.database.close();
  }

  public getEntries(repository?: string): readonly LocalEntry[] {
    const rows =
      repository === undefined
        ? this.database
            .prepare("SELECT * FROM local_entries ORDER BY repository, path")
            .all()
        : this.database
            .prepare(
              "SELECT * FROM local_entries WHERE repository = ? ORDER BY path",
            )
            .all(repository);
    return rows.map(parseLocalEntry);
  }

  public entryCount(repository?: string): number {
    const row =
      repository === undefined
        ? this.database
            .prepare("SELECT COUNT(*) AS count FROM local_entries")
            .get()
        : this.database
            .prepare(
              "SELECT COUNT(*) AS count FROM local_entries WHERE repository = ?",
            )
            .get(repository);
    return Number((row as { readonly count?: unknown }).count ?? 0);
  }

  public getEntry(repository: string, path: string): LocalEntry | null {
    const row = this.database
      .prepare("SELECT * FROM local_entries WHERE repository = ? AND path = ?")
      .get(repository, path);
    return row === undefined ? null : parseLocalEntry(row);
  }

  public getEntryByNode(repository: string, nodeId: string): LocalEntry | null {
    const row = this.database
      .prepare(
        "SELECT * FROM local_entries WHERE repository = ? AND node_id = ?",
      )
      .get(repository, nodeId);
    return row === undefined ? null : parseLocalEntry(row);
  }

  public getEntryByIdentity(
    repository: string,
    device: number,
    inode: number,
  ): LocalEntry | null {
    const row = this.database
      .prepare(
        "SELECT * FROM local_entries WHERE repository = ? AND device = ? AND inode = ?",
      )
      .get(repository, device, inode);
    return row === undefined ? null : parseLocalEntry(row);
  }

  public replaceEntry(entry: LocalEntry): void {
    this.database
      .prepare(
        `
        INSERT INTO local_entries (
          repository, path, parent_node_id, name, node_id, entry_version,
          kind, manifest_id, content_version, device, inode,
          observed_size, observed_mtime_ms, observed_ctime_ms, observed_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repository, path) DO UPDATE SET
          parent_node_id=excluded.parent_node_id,
          name=excluded.name,
          node_id=excluded.node_id,
          entry_version=excluded.entry_version,
          kind=excluded.kind,
          manifest_id=excluded.manifest_id,
          content_version=excluded.content_version,
          device=excluded.device,
          inode=excluded.inode,
          observed_size=excluded.observed_size,
          observed_mtime_ms=excluded.observed_mtime_ms,
          observed_ctime_ms=excluded.observed_ctime_ms,
          observed_mode=excluded.observed_mode
      `,
      )
      .run(
        entry.repository,
        entry.path,
        entry.parentNodeId,
        entry.name,
        entry.nodeId,
        entry.entryVersion,
        entry.kind,
        entry.manifestId,
        entry.contentVersion,
        entry.device,
        entry.inode,
        entry.observedSize,
        entry.observedMtimeMs,
        entry.observedCtimeMs,
        entry.observedMode,
      );
  }

  public removeEntry(repository: string, path: string): void {
    this.database
      .prepare("DELETE FROM local_entries WHERE repository = ? AND path = ?")
      .run(repository, path);
  }

  public replaceAllEntries(
    repository: string,
    entries: readonly LocalEntry[],
  ): void {
    this.transaction(() => {
      this.database
        .prepare("DELETE FROM local_entries WHERE repository = ?")
        .run(repository);
      for (const entry of entries) this.replaceEntry(entry);
    });
  }

  public getGitState(repository: string): GitStateRecord {
    const row = this.database
      .prepare(
        "SELECT repository, version, manifest_id FROM local_git WHERE repository = ?",
      )
      .get(repository);
    if (row === undefined)
      return { repository, version: null, manifestId: null };
    const input = row as Record<string, unknown>;
    return {
      repository: requiredString(input.repository, "Repository"),
      version: nullableString(input.version, "Git version"),
      manifestId: nullableString(input.manifest_id, "Git manifest"),
    };
  }

  public setGitState(state: GitStateRecord): void {
    this.database
      .prepare(
        `
        INSERT INTO local_git(repository, version, manifest_id) VALUES (?, ?, ?)
        ON CONFLICT(repository) DO UPDATE SET
          version=excluded.version, manifest_id=excluded.manifest_id
      `,
      )
      .run(state.repository, state.version, state.manifestId);
  }

  public nextPeerSequence(): number {
    return (
      this.reservePeerSequences(1)[0] ?? fail("Failed to reserve peer sequence")
    );
  }

  public reservePeerSequences(count: number): readonly number[] {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Sequence reservation count is invalid");
    if (count === 0) return [];
    let first = 0;
    this.transaction(() => {
      first = Number(this.getMeta("peerSequence") ?? "0") + 1;
      this.setMeta("peerSequence", String(first + count - 1));
    });
    return Array.from({ length: count }, (_, index) => first + index);
  }

  public queueEvent(event: EventRequest, objectIds: readonly string[]): void {
    this.database
      .prepare(
        `
        INSERT INTO outbox(event_id, peer_sequence, event_json, object_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.eventId,
        event.peerSequence,
        JSON.stringify(event),
        JSON.stringify([...new Set(objectIds)]),
        event.createdAt,
      );
  }

  public queueEvents(
    values: readonly {
      readonly event: EventRequest;
      readonly objectIds: readonly string[];
    }[],
  ): void {
    this.transaction(() => {
      for (const value of values) this.queueEvent(value.event, value.objectIds);
    });
  }

  public listOutbox(): readonly OutboxRecord[] {
    return this.database
      .prepare(
        "SELECT event_json, object_ids_json FROM outbox ORDER BY peer_sequence",
      )
      .all()
      .map((row) => {
        const input = row as Record<string, unknown>;
        const event = JSON.parse(
          requiredString(input.event_json, "Event JSON"),
        ) as EventRequest;
        const objectIds = JSON.parse(
          requiredString(input.object_ids_json, "Object IDs JSON"),
        ) as unknown;
        if (
          !Array.isArray(objectIds) ||
          objectIds.some((id) => typeof id !== "string")
        )
          throw new Error("Invalid outbox object IDs");
        return { event, objectIds };
      });
  }

  public acknowledge(result: EventResult): void {
    this.acknowledgeMany([result]);
  }

  public acknowledgeMany(
    results: readonly EventResult[],
    advanceCursor = true,
  ): void {
    if (results.length === 0) return;
    this.transaction(() => {
      const remove = this.database.prepare(
        "DELETE FROM outbox WHERE event_id = ?",
      );
      let cursor = this.cursor();
      for (const result of results) {
        remove.run(result.eventId);
        cursor = Math.max(cursor, result.hubSequence);
      }
      if (advanceCursor) this.setCursor(cursor);
    });
  }

  public cursor(): number {
    return Number(this.getMeta("hubCursor") ?? "0");
  }

  public setCursor(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid hub cursor");
    this.setMeta("hubCursor", String(value));
  }

  public storeConflicts(conflicts: readonly ConflictRecord[]): void {
    this.transaction(() => {
      for (const conflict of conflicts) {
        this.database
          .prepare(
            `
            INSERT INTO conflicts(conflict_id, record_json, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(conflict_id) DO UPDATE SET record_json=excluded.record_json
          `,
          )
          .run(
            conflict.conflictId,
            JSON.stringify(conflict),
            conflict.createdAt,
          );
      }
    });
  }

  public conflicts(): readonly ConflictRecord[] {
    return this.database
      .prepare(
        "SELECT record_json FROM conflicts ORDER BY created_at, conflict_id",
      )
      .all()
      .map(
        (row) =>
          JSON.parse(
            requiredString(
              (row as Record<string, unknown>).record_json,
              "Conflict JSON",
            ),
          ) as ConflictRecord,
      );
  }

  public beginApply(transactionId: string, payload: unknown): void {
    this.database
      .prepare(
        "INSERT INTO apply_journal(transaction_id, state, payload_json, created_at) VALUES (?, 'prepared', ?, ?)",
      )
      .run(transactionId, JSON.stringify(payload), new Date().toISOString());
  }

  public finishApply(transactionId: string): void {
    this.database
      .prepare("DELETE FROM apply_journal WHERE transaction_id = ?")
      .run(transactionId);
  }

  public pendingApplies(): readonly {
    readonly transactionId: string;
    readonly payload: unknown;
  }[] {
    return this.database
      .prepare(
        "SELECT transaction_id, payload_json FROM apply_journal ORDER BY created_at",
      )
      .all()
      .map((row) => {
        const input = row as Record<string, unknown>;
        return {
          transactionId: requiredString(input.transaction_id, "Transaction ID"),
          payload: JSON.parse(
            requiredString(input.payload_json, "Apply payload"),
          ) as unknown,
        };
      });
  }

  public outboxCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM outbox")
      .get();
    return Number((row as Record<string, unknown>).count ?? 0);
  }

  public hasPublicationHistory(): boolean {
    return Number(this.getMeta("peerSequence") ?? "0") > 0;
  }

  public markInitialJoin(): void {
    this.setMeta("initialJoinPending", "1");
  }

  public initialJoinPending(): boolean {
    return this.getMeta("initialJoinPending") === "1";
  }

  public completeInitialJoin(): void {
    this.setMeta("initialJoinPending", "0");
  }

  private initialize(config: ProductConfig): void {
    const folderId = this.getMeta("folderId");
    const peerId = this.getMeta("peerId");
    if (
      folderId !== null &&
      (folderId !== config.folderId || peerId !== config.peerId)
    )
      throw new Error("Local state belongs to a different folder or peer");
    this.setMeta("folderId", config.folderId);
    this.setMeta("peerId", config.peerId);
    if (this.getMeta("peerSequence") === null)
      this.setMeta("peerSequence", "0");
    if (this.getMeta("hubCursor") === null) this.setMeta("hubCursor", "0");
  }

  private getMeta(key: string): string | null {
    const row = this.database
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row === undefined
      ? null
      : requiredString((row as Record<string, unknown>).value, `Meta ${key}`);
  }

  private setMeta(key: string, value: string): void {
    this.database
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseLocalEntry(value: unknown): LocalEntry {
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "directory" && kind !== "regular" && kind !== "symlink")
    throw new Error("Invalid local entry kind");
  return {
    repository: requiredString(input.repository, "Repository"),
    path: requiredString(input.path, "Path"),
    parentNodeId: requiredString(input.parent_node_id, "Parent node"),
    name: requiredString(input.name, "Name"),
    nodeId: requiredString(input.node_id, "Node ID"),
    entryVersion: requiredString(input.entry_version, "Entry version"),
    kind,
    manifestId: nullableString(input.manifest_id, "Manifest ID"),
    contentVersion: requiredString(input.content_version, "Content version"),
    device: nullableNumber(input.device, "Device"),
    inode: nullableNumber(input.inode, "Inode"),
    observedSize: nullableNumber(input.observed_size, "Observed size"),
    observedMtimeMs: nullableFinite(input.observed_mtime_ms, "Observed mtime"),
    observedCtimeMs: nullableFinite(input.observed_ctime_ms, "Observed ctime"),
    observedMode: nullableNumber(input.observed_mode, "Observed mode"),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${label} must be an integer`);
  return value;
}

function nullableFinite(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be finite`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
