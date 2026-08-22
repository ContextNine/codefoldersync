import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { contentVersion, entryVersion } from "./mutations.js";
import type { CatalogEntry, ConflictRecord, ProductConfig } from "./types.js";

export class LocalState implements Disposable {
  private readonly database: DatabaseSync;

  public constructor(config: ProductConfig) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(config.stateDir, "state.sqlite"));
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS catalog (
        path TEXT PRIMARY KEY,
        node_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        manifest_id TEXT,
        device INTEGER NOT NULL,
        inode INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ctime_ms REAL NOT NULL,
        json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS catalog_identity ON catalog(device, inode);
      CREATE TABLE IF NOT EXISTS catalog_history (
        node_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        entry_version TEXT NOT NULL,
        content_version TEXT NOT NULL,
        tombstone INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(node_id, sequence)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS journals (
        journal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        object_ids_json TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  public [Symbol.dispose](): void {
    this.database.close();
  }

  public getMeta(key: string): string | null {
    const row = this.database
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { readonly value?: unknown } | undefined;
    return row === undefined ? null : String(row.value);
  }

  public setMeta(key: string, value: string): void {
    this.database
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  public sequence(): number {
    return Number(this.getMeta("hub-sequence") ?? "0");
  }

  public nextPeerSequence(): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const next = Number(this.getMeta("peer-sequence") ?? "0") + 1;
      if (!Number.isSafeInteger(next) || next < 1)
        throw new Error("Local peer sequence is invalid");
      this.setMeta("peer-sequence", String(next));
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public baselineDigest(): string | null {
    return this.getMeta("baseline-digest");
  }

  public catalog(): readonly CatalogEntry[] {
    return this.database
      .prepare("SELECT json FROM catalog ORDER BY path")
      .all()
      .map(
        (row) =>
          JSON.parse(String((row as { json: unknown }).json)) as CatalogEntry,
      );
  }

  public replaceCatalog(
    entries: readonly CatalogEntry[],
    acceptedSequence?: number,
  ): void {
    const previous =
      acceptedSequence !== undefined &&
      this.getMeta("catalog-accepted-sequence") !== null
        ? this.catalog()
        : [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM catalog");
      const insert = this.database.prepare(
        "INSERT INTO catalog(path,node_id,kind,manifest_id,device,inode,size,mtime_ms,ctime_ms,json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (const entry of entries)
        insert.run(
          entry.path,
          entry.nodeId,
          entry.kind,
          entry.manifestId,
          entry.device,
          entry.inode,
          entry.size,
          entry.mtimeMs,
          entry.ctimeMs,
          JSON.stringify(entry),
        );
      if (acceptedSequence !== undefined) {
        const priorByNode = new Map(
          previous.map((entry) => [entry.nodeId, entry]),
        );
        const next = new Map(entries.map((entry) => [entry.nodeId, entry]));
        const history = this.database.prepare(
          "INSERT OR IGNORE INTO catalog_history(node_id,sequence,entry_version,content_version,tombstone,json) VALUES (?,?,?,?,?,?)",
        );
        for (const entry of entries) {
          const prior = priorByNode.get(entry.nodeId);
          if (
            prior !== undefined &&
            entryVersion(prior) === entryVersion(entry) &&
            contentVersion(prior) === contentVersion(entry)
          )
            continue;
          history.run(
            entry.nodeId,
            acceptedSequence,
            entryVersion(entry),
            contentVersion(entry),
            0,
            JSON.stringify(entry),
          );
        }
        for (const entry of previous) {
          if (next.has(entry.nodeId)) continue;
          history.run(
            entry.nodeId,
            acceptedSequence,
            entryVersion(entry),
            contentVersion(entry),
            1,
            JSON.stringify(entry),
          );
        }
        this.setMeta("catalog-accepted-sequence", String(acceptedSequence));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public catalogHistory(): readonly {
    readonly nodeId: string;
    readonly sequence: number;
    readonly entryVersion: string;
    readonly contentVersion: string;
    readonly tombstone: boolean;
    readonly entry: CatalogEntry;
  }[] {
    return this.database
      .prepare(
        "SELECT node_id,sequence,entry_version,content_version,tombstone,json FROM catalog_history ORDER BY sequence,node_id",
      )
      .all()
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          nodeId: String(value.node_id),
          sequence: Number(value.sequence),
          entryVersion: String(value.entry_version),
          contentVersion: String(value.content_version),
          tombstone: Number(value.tombstone) === 1,
          entry: JSON.parse(String(value.json)) as CatalogEntry,
        };
      });
  }

  public tombstonedNodeIds(): ReadonlySet<string> {
    return new Set(
      this.catalogHistory()
        .filter((entry) => entry.tombstone)
        .map((entry) => entry.nodeId),
    );
  }

  public acceptBaseline(sequence: number, digest: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.setMeta("hub-sequence", String(sequence));
      this.setMeta("baseline-digest", digest);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public putJournal(
    id: string,
    kind: string,
    value: unknown,
    status = "prepared",
  ): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO journals(journal_id,kind,status,json) VALUES (?,?,?,?)",
      )
      .run(id, kind, status, JSON.stringify(value));
  }

  public completeJournal(id: string): void {
    this.database.prepare("DELETE FROM journals WHERE journal_id = ?").run(id);
  }

  public journals(): readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly value: unknown;
  }[] {
    return this.database
      .prepare(
        "SELECT journal_id,kind,status,json FROM journals ORDER BY journal_id",
      )
      .all()
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.journal_id),
          kind: String(value.kind),
          status: String(value.status),
          value: JSON.parse(String(value.json)) as unknown,
        };
      });
  }

  public addConflict(conflict: ConflictRecord): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO conflicts(conflict_id,json) VALUES (?,?)",
      )
      .run(conflict.conflictId, JSON.stringify(conflict));
  }

  public queueOutbox(
    eventId: string,
    value: unknown,
    objectIds: readonly string[],
  ): void {
    this.database
      .prepare(
        "INSERT INTO outbox(event_id,json,object_ids_json) VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET json=excluded.json, object_ids_json=excluded.object_ids_json",
      )
      .run(eventId, JSON.stringify(value), JSON.stringify(objectIds));
  }

  public outbox(): readonly {
    readonly eventId: string;
    readonly value: unknown;
    readonly objectIds: readonly string[];
  }[] {
    return this.database
      .prepare(
        "SELECT event_id,json,object_ids_json FROM outbox ORDER BY event_id",
      )
      .all()
      .map((row) => {
        const value = row as Record<string, unknown>;
        const objectIds = JSON.parse(String(value.object_ids_json)) as unknown;
        if (
          !Array.isArray(objectIds) ||
          objectIds.some((id) => typeof id !== "string")
        )
          throw new Error("Durable outbox object list is invalid");
        return {
          eventId: String(value.event_id),
          value: JSON.parse(String(value.json)) as unknown,
          objectIds,
        };
      });
  }

  public acknowledgeOutbox(eventId: string): void {
    this.database.prepare("DELETE FROM outbox WHERE event_id=?").run(eventId);
  }

  public conflicts(): readonly ConflictRecord[] {
    return this.database
      .prepare("SELECT json FROM conflicts ORDER BY conflict_id")
      .all()
      .map(
        (row) =>
          JSON.parse(String((row as { json: unknown }).json)) as ConflictRecord,
      );
  }
}
