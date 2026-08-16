import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashJson } from "./hash.js";
import { ObjectStore, referencedObjects } from "./objects.js";
import {
  conflictName,
  normalizedEntryKey,
  normalizeRelativePath,
} from "./paths.js";
import {
  protocolVersion,
  schemaVersion,
  type Checkpoint,
  type ChangeBatch,
  type ConflictRecord,
  type EntryRecord,
  type EventRequest,
  type EventResult,
  type FolderRecord,
  type GitMutation,
  type GitStateRecord,
  type Mutation,
  type NodeKind,
  type NodeRecord,
  type PutMutation,
  type RenameMutation,
} from "./types.js";

interface EntryRow extends EntryRecord {
  readonly nameKey: string;
  readonly lastEventId: string;
}

interface NodeRow extends NodeRecord {
  readonly lastEventId: string;
}

export class HubStore implements Disposable {
  public readonly objects: ObjectStore;
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    const root = resolve(path);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.objects = new ObjectStore(join(root, "objects"));
    this.database = new DatabaseSync(join(root, "hub.sqlite"));
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        folder_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repositories (
        folder_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        root_node_id TEXT NOT NULL,
        PRIMARY KEY(folder_id, repository),
        UNIQUE(folder_id, root_node_id)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        folder_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        manifest_id TEXT,
        content_version TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        PRIMARY KEY(folder_id, repository, node_id)
      );
      CREATE TABLE IF NOT EXISTS entries (
        folder_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        parent_node_id TEXT NOT NULL,
        name_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        entry_version TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        PRIMARY KEY(folder_id, repository, parent_node_id, name_key),
        UNIQUE(folder_id, repository, node_id)
      );
      CREATE TABLE IF NOT EXISTS git_states (
        folder_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        manifest_id TEXT,
        version TEXT,
        last_event_id TEXT,
        PRIMARY KEY(folder_id, repository)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        peer_id TEXT NOT NULL,
        peer_sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(folder_id, peer_id, peer_sequence)
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
  }

  public [Symbol.dispose](): void {
    this.database.close();
    this.objects[Symbol.dispose]();
  }

  public createFolder(folder: FolderRecord): FolderRecord {
    validateFolder(folder);
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT record_json FROM folders WHERE folder_id = ?")
        .get(folder.folderId);
      if (existing !== undefined) {
        const current = JSON.parse(
          requiredString(
            (existing as Record<string, unknown>).record_json,
            "Folder JSON",
          ),
        ) as FolderRecord;
        if (JSON.stringify(current) !== JSON.stringify(folder))
          throw new Error("Folder ID already exists with different metadata");
        return;
      }
      this.database
        .prepare("INSERT INTO folders(folder_id, record_json) VALUES (?, ?)")
        .run(folder.folderId, JSON.stringify(folder));
      for (const repository of folder.repositories) {
        const rootVersion = hashJson({
          type: "root",
          folderId: folder.folderId,
          repository: repository.name,
          nodeId: repository.rootNodeId,
        });
        this.database
          .prepare(
            "INSERT INTO repositories(folder_id, repository, root_node_id) VALUES (?, ?, ?)",
          )
          .run(folder.folderId, repository.name, repository.rootNodeId);
        this.database
          .prepare(
            `
            INSERT INTO nodes(
              folder_id, repository, node_id, kind, manifest_id,
              content_version, last_event_id
            ) VALUES (?, ?, ?, 'directory', NULL, ?, 'root')
          `,
          )
          .run(
            folder.folderId,
            repository.name,
            repository.rootNodeId,
            rootVersion,
          );
        this.database
          .prepare(
            "INSERT INTO git_states(folder_id, repository, manifest_id, version, last_event_id) VALUES (?, ?, NULL, NULL, NULL)",
          )
          .run(folder.folderId, repository.name);
      }
    });
    return folder;
  }

  public getFolder(folderId: string): FolderRecord {
    const row = this.database
      .prepare("SELECT record_json FROM folders WHERE folder_id = ?")
      .get(folderId);
    if (row === undefined) throw new Error(`Unknown folder: ${folderId}`);
    const folder = JSON.parse(
      requiredString(
        (row as Record<string, unknown>).record_json,
        "Folder JSON",
      ),
    ) as FolderRecord;
    validateFolder(folder);
    return folder;
  }

  public checkpoint(folderId: string): Checkpoint {
    const folder = this.getFolder(folderId);
    const activeRepositories = new Set(
      folder.repositories.map((repository) => repository.name),
    );
    const sequenceRow = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE folder_id = ?",
      )
      .get(folderId) as Record<string, unknown>;
    const entries = this.database
      .prepare(
        `
        SELECT repository, parent_node_id, display_name, node_id, entry_version
        FROM entries WHERE folder_id = ? ORDER BY repository, parent_node_id, name_key
      `,
      )
      .all(folderId)
      .map((row) => parseEntry(row))
      .filter((entry) => activeRepositories.has(entry.repository));
    const nodes = this.database
      .prepare(
        `
        SELECT repository, node_id, kind, manifest_id, content_version
        FROM nodes WHERE folder_id = ? ORDER BY repository, node_id
      `,
      )
      .all(folderId)
      .map((row) => parseNode(row))
      .filter((node) => activeRepositories.has(node.repository));
    const gitStates = this.database
      .prepare(
        "SELECT repository, manifest_id, version FROM git_states WHERE folder_id = ? ORDER BY repository",
      )
      .all(folderId)
      .map(parseGitState)
      .filter((state) => activeRepositories.has(state.repository));
    return {
      folder,
      sequence: Number(sequenceRow.sequence ?? 0),
      entries,
      nodes,
      gitStates,
    };
  }

  public updateRepositories(
    folderId: string,
    expected: readonly string[],
    repositories: FolderRecord["repositories"],
  ): FolderRecord {
    const current = this.getFolder(folderId);
    if (
      JSON.stringify(
        current.repositories.map((repository) => repository.name),
      ) !== JSON.stringify(expected)
    ) {
      throw new Error("Folder repository membership changed concurrently");
    }
    const next: FolderRecord = { ...current, repositories: [...repositories] };
    validateFolder(next);
    this.transaction(() => {
      for (const repository of repositories) {
        const existing = this.database
          .prepare(
            "SELECT root_node_id FROM repositories WHERE folder_id = ? AND repository = ?",
          )
          .get(folderId, repository.name) as
          Record<string, unknown> | undefined;
        if (existing !== undefined) {
          if (
            requiredString(existing.root_node_id, "Root node") !==
            repository.rootNodeId
          )
            throw new Error(
              `Repository root identity changed: ${repository.name}`,
            );
          continue;
        }
        const rootVersion = hashJson({
          type: "root",
          folderId,
          repository: repository.name,
          nodeId: repository.rootNodeId,
        });
        this.database
          .prepare(
            "INSERT INTO repositories(folder_id, repository, root_node_id) VALUES (?, ?, ?)",
          )
          .run(folderId, repository.name, repository.rootNodeId);
        this.database
          .prepare(
            `
            INSERT INTO nodes(
              folder_id, repository, node_id, kind, manifest_id,
              content_version, last_event_id
            ) VALUES (?, ?, ?, 'directory', NULL, ?, 'root')
          `,
          )
          .run(folderId, repository.name, repository.rootNodeId, rootVersion);
        this.database
          .prepare(
            "INSERT INTO git_states(folder_id, repository, manifest_id, version, last_event_id) VALUES (?, ?, NULL, NULL, NULL)",
          )
          .run(folderId, repository.name);
      }
      this.database
        .prepare("UPDATE folders SET record_json = ? WHERE folder_id = ?")
        .run(JSON.stringify(next), folderId);
    });
    return next;
  }

  public updateIgnorePatterns(
    folderId: string,
    expected: readonly string[],
    patterns: readonly string[],
  ): FolderRecord {
    const current = this.getFolder(folderId);
    if (JSON.stringify(current.ignorePatterns) !== JSON.stringify(expected))
      throw new Error("Ignore rules changed concurrently");
    const next: FolderRecord = { ...current, ignorePatterns: [...patterns] };
    validateFolder(next);
    this.database
      .prepare("UPDATE folders SET record_json = ? WHERE folder_id = ?")
      .run(JSON.stringify(next), folderId);
    return next;
  }

  public sequence(folderId: string): number {
    this.getFolder(folderId);
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE folder_id = ?",
      )
      .get(folderId) as Record<string, unknown>;
    return Number(row.sequence ?? 0);
  }

  public hasObjects(ids: readonly string[]): readonly string[] {
    return ids.filter((id) => !this.objects.has(id));
  }

  public submit(event: EventRequest): EventResult {
    const result = this.submitMany([event])[0];
    if (result === undefined)
      throw new Error("Hub transaction returned no result");
    return result;
  }

  public submitMany(events: readonly EventRequest[]): readonly EventResult[] {
    for (const event of events) {
      validateEvent(event);
      this.getFolder(event.folderId);
      validateEventObjects(event.mutation, this.objects);
    }
    const results: EventResult[] = [];
    this.transaction(() => {
      for (const event of events) {
        const duplicate = this.database
          .prepare("SELECT result_json FROM events WHERE event_id = ?")
          .get(event.eventId);
        if (duplicate !== undefined) {
          results.push(parseStoredResult(duplicate));
          continue;
        }
        const inserted = this.database
          .prepare(
            `
            INSERT INTO events(
              folder_id, event_id, peer_id, peer_sequence, event_json, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `,
          )
          .run(
            event.folderId,
            event.eventId,
            event.peerId,
            event.peerSequence,
            JSON.stringify(event),
            event.createdAt,
          );
        const value = this.applyEvent(event, Number(inserted.lastInsertRowid));
        this.database
          .prepare("UPDATE events SET result_json = ? WHERE event_id = ?")
          .run(JSON.stringify(value), event.eventId);
        results.push(value);
      }
    });
    return results;
  }

  public conflicts(folderId: string): readonly ConflictRecord[] {
    this.getFolder(folderId);
    return this.database
      .prepare(
        "SELECT record_json FROM conflicts WHERE folder_id = ? ORDER BY created_at, conflict_id",
      )
      .all(folderId)
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

  public resolveConflict(
    folderId: string,
    conflictId: string,
    resolution: "canonical" | "conflict" | "filesystem",
  ): ConflictRecord {
    this.getFolder(folderId);
    const row = this.database
      .prepare(
        "SELECT record_json FROM conflicts WHERE folder_id = ? AND conflict_id = ?",
      )
      .get(folderId, conflictId);
    if (row === undefined) throw new Error(`Unknown conflict: ${conflictId}`);
    const current = JSON.parse(
      requiredString(
        (row as Record<string, unknown>).record_json,
        "Conflict JSON",
      ),
    ) as ConflictRecord;
    const resolved: ConflictRecord = {
      ...current,
      resolvedAt: current.resolvedAt ?? new Date().toISOString(),
      resolution: current.resolution ?? resolution,
    };
    this.database
      .prepare("UPDATE conflicts SET record_json = ? WHERE conflict_id = ?")
      .run(JSON.stringify(resolved), conflictId);
    return resolved;
  }

  public changes(folderId: string, after: number, limit = 1000): ChangeBatch {
    this.getFolder(folderId);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid change cursor");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000)
      throw new Error("Invalid change limit");
    const rows = this.database
      .prepare(
        `
        SELECT sequence, event_json, result_json FROM events
        WHERE folder_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
      `,
      )
      .all(folderId, after, limit + 1);
    const selected = rows.slice(0, limit);
    const changes = selected.map((row) => {
      const input = row as Record<string, unknown>;
      return {
        event: JSON.parse(
          requiredString(input.event_json, "Event JSON"),
        ) as EventRequest,
        result: JSON.parse(
          requiredString(input.result_json, "Result JSON"),
        ) as EventResult,
      };
    });
    return {
      after,
      sequence: changes.at(-1)?.result.hubSequence ?? after,
      hasMore: rows.length > limit,
      changes,
    };
  }

  public history(
    folderId: string,
    repository?: string,
  ): readonly { readonly event: EventRequest; readonly result: EventResult }[] {
    this.getFolder(folderId);
    const rows = this.database
      .prepare(
        "SELECT event_json, result_json FROM events WHERE folder_id = ? ORDER BY sequence",
      )
      .all(folderId);
    return rows
      .map((row) => {
        const input = row as Record<string, unknown>;
        return {
          event: JSON.parse(
            requiredString(input.event_json, "Event JSON"),
          ) as EventRequest,
          result: JSON.parse(
            requiredString(input.result_json, "Result JSON"),
          ) as EventResult,
        };
      })
      .filter(({ event }) =>
        repository === undefined
          ? true
          : event.mutation.repository === repository,
      );
  }

  public gcDryRun(): {
    readonly totalObjects: number;
    readonly reachableObjects: number;
    readonly unreachableObjects: number;
    readonly unreachableBytes: number;
    readonly unreachableIds: readonly string[];
    readonly automaticDeletion: false;
  } {
    const roots = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value === "string") roots.add(value);
    };
    for (const row of this.database
      .prepare("SELECT manifest_id FROM nodes")
      .all())
      add((row as Record<string, unknown>).manifest_id);
    for (const row of this.database
      .prepare("SELECT manifest_id FROM git_states")
      .all())
      add((row as Record<string, unknown>).manifest_id);
    for (const row of this.database
      .prepare("SELECT record_json FROM conflicts")
      .all()) {
      const record = JSON.parse(
        requiredString(
          (row as Record<string, unknown>).record_json,
          "Conflict JSON",
        ),
      ) as ConflictRecord;
      add(record.manifestId);
    }
    for (const row of this.database
      .prepare("SELECT event_json FROM events")
      .all()) {
      const event = JSON.parse(
        requiredString(
          (row as Record<string, unknown>).event_json,
          "Event JSON",
        ),
      ) as EventRequest;
      if (event.mutation.kind === "put" || event.mutation.kind === "git-state")
        add(event.mutation.manifestId);
    }
    const reachable = new Set<string>();
    for (const root of roots) {
      for (const id of referencedObjects(root, this.objects)) reachable.add(id);
    }
    const all = this.objects.listIds();
    const unreachableIds = all.filter((id) => !reachable.has(id));
    return {
      totalObjects: all.length,
      reachableObjects: reachable.size,
      unreachableObjects: unreachableIds.length,
      unreachableBytes: unreachableIds.reduce(
        (bytes, id) => bytes + this.objects.size(id),
        0,
      ),
      unreachableIds,
      automaticDeletion: false,
    };
  }

  private applyEvent(event: EventRequest, sequence: number): EventResult {
    switch (event.mutation.kind) {
      case "put":
        return this.applyPut(event, event.mutation, sequence);
      case "delete":
        return this.applyDelete(event, sequence);
      case "rename":
        return this.applyRename(event, event.mutation, sequence);
      case "git-state":
        return this.applyGit(event, event.mutation, sequence);
    }
  }

  private applyPut(
    event: EventRequest,
    mutation: PutMutation,
    sequence: number,
  ): EventResult {
    this.assertRepository(event.folderId, mutation.repository);
    this.assertDirectoryNode(
      event.folderId,
      mutation.repository,
      mutation.parentNodeId,
    );
    const node = this.node(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
    );
    if (node !== null) {
      const liveEntry = this.entryByNode(
        event.folderId,
        mutation.repository,
        mutation.nodeId,
      );
      if (
        liveEntry !== null &&
        node.contentVersion === mutation.baseContentVersion
      ) {
        if (
          node.manifestId === mutation.manifestId &&
          node.kind === mutation.nodeKind
        ) {
          return result(
            event,
            sequence,
            "coalesced",
            node.nodeId,
            this.pathForEntry(event.folderId, liveEntry),
            liveEntry.entryVersion,
            node.contentVersion,
          );
        }
        const contentVersion = version(event.eventId, "content");
        this.database
          .prepare(
            `
            UPDATE nodes SET kind = ?, manifest_id = ?, content_version = ?, last_event_id = ?
            WHERE folder_id = ? AND repository = ? AND node_id = ?
          `,
          )
          .run(
            mutation.nodeKind,
            mutation.manifestId,
            contentVersion,
            event.eventId,
            event.folderId,
            mutation.repository,
            node.nodeId,
          );
        return result(
          event,
          sequence,
          "canonical",
          node.nodeId,
          this.pathForEntry(event.folderId, liveEntry),
          liveEntry.entryVersion,
          contentVersion,
        );
      }
      if (liveEntry !== null && node.manifestId === mutation.manifestId) {
        return result(
          event,
          sequence,
          "coalesced",
          node.nodeId,
          this.pathForEntry(event.folderId, liveEntry),
          liveEntry.entryVersion,
          node.contentVersion,
        );
      }
      const targetEntry = liveEntry ?? {
        repository: mutation.repository,
        parentNodeId: mutation.parentNodeId,
        name: mutation.name,
        nameKey: normalizedEntryKey(mutation.name),
        nodeId: mutation.nodeId,
        entryVersion: mutation.baseEntryVersion ?? "missing",
        lastEventId: node.lastEventId,
      };
      return this.createConflictClone(
        event,
        mutation,
        targetEntry,
        sequence,
        "content",
      );
    }

    const occupied = this.entryAt(
      event.folderId,
      mutation.repository,
      mutation.parentNodeId,
      mutation.name,
    );
    if (occupied === null && mutation.baseEntryVersion === null) {
      const entryVersion = version(event.eventId, "entry");
      const contentVersion = version(event.eventId, "content");
      this.insertNodeAndEntry(
        event,
        mutation,
        mutation.nodeId,
        mutation.parentNodeId,
        mutation.name,
        entryVersion,
        contentVersion,
      );
      return result(
        event,
        sequence,
        "canonical",
        mutation.nodeId,
        this.pathForNode(event.folderId, mutation.repository, mutation.nodeId),
        entryVersion,
        contentVersion,
      );
    }
    const base = occupied ?? {
      repository: mutation.repository,
      parentNodeId: mutation.parentNodeId,
      name: mutation.name,
      nameKey: normalizedEntryKey(mutation.name),
      nodeId: mutation.nodeId,
      entryVersion: mutation.baseEntryVersion ?? "missing",
      lastEventId: "missing",
    };
    return this.createConflictClone(
      event,
      mutation,
      base,
      sequence,
      "entry",
      mutation.nodeId,
    );
  }

  private applyDelete(event: EventRequest, sequence: number): EventResult {
    const mutation = event.mutation;
    if (mutation.kind !== "delete") throw new Error("Expected delete");
    const node = this.node(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
    );
    const entry = this.entryByNode(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
    );
    const originalPath =
      entry === null ? mutation.name : this.pathForEntry(event.folderId, entry);
    if (
      node !== null &&
      entry !== null &&
      node.contentVersion === mutation.baseContentVersion &&
      entry.entryVersion === mutation.baseEntryVersion &&
      entry.parentNodeId === mutation.parentNodeId &&
      entry.name === mutation.name
    ) {
      this.database
        .prepare(
          "DELETE FROM entries WHERE folder_id = ? AND repository = ? AND node_id = ?",
        )
        .run(event.folderId, mutation.repository, mutation.nodeId);
      return result(
        event,
        sequence,
        "canonical",
        mutation.nodeId,
        originalPath,
        null,
        node.contentVersion,
      );
    }
    const conflict = this.recordConflict({
      event,
      originalPath,
      conflictPath: null,
      canonicalEventId: node?.lastEventId ?? entry?.lastEventId ?? null,
      kind: "delete",
      manifestId: node?.manifestId ?? null,
    });
    return {
      ...result(
        event,
        sequence,
        "tombstone-conflict",
        mutation.nodeId,
        null,
        entry?.entryVersion ?? null,
        node?.contentVersion ?? null,
      ),
      conflictId: conflict.conflictId,
    };
  }

  private applyRename(
    event: EventRequest,
    mutation: RenameMutation,
    sequence: number,
  ): EventResult {
    this.assertDirectoryNode(
      event.folderId,
      mutation.repository,
      mutation.toParentNodeId,
    );
    const entry = this.entryByNode(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
    );
    const destination = this.entryAt(
      event.folderId,
      mutation.repository,
      mutation.toParentNodeId,
      mutation.toName,
    );
    if (
      entry !== null &&
      entry.entryVersion === mutation.baseEntryVersion &&
      entry.parentNodeId === mutation.fromParentNodeId &&
      entry.name === mutation.fromName &&
      destination === null
    ) {
      const entryVersion = version(event.eventId, "entry");
      this.database
        .prepare(
          `
          UPDATE entries SET parent_node_id = ?, name_key = ?, display_name = ?,
            entry_version = ?, last_event_id = ?
          WHERE folder_id = ? AND repository = ? AND node_id = ?
        `,
        )
        .run(
          mutation.toParentNodeId,
          normalizedEntryKey(mutation.toName),
          mutation.toName,
          entryVersion,
          event.eventId,
          event.folderId,
          mutation.repository,
          mutation.nodeId,
        );
      const node = this.requiredNode(
        event.folderId,
        mutation.repository,
        mutation.nodeId,
      );
      return result(
        event,
        sequence,
        "canonical",
        mutation.nodeId,
        this.pathForNode(event.folderId, mutation.repository, mutation.nodeId),
        entryVersion,
        node.contentVersion,
      );
    }
    if (
      entry !== null &&
      entry.parentNodeId === mutation.toParentNodeId &&
      entry.name === mutation.toName
    ) {
      const node = this.requiredNode(
        event.folderId,
        mutation.repository,
        mutation.nodeId,
      );
      return result(
        event,
        sequence,
        "coalesced",
        mutation.nodeId,
        this.pathForEntry(event.folderId, entry),
        entry.entryVersion,
        node.contentVersion,
      );
    }
    const node = this.requiredNode(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
    );
    const generated = this.availableConflictName(
      event.folderId,
      mutation.repository,
      mutation.toParentNodeId,
      mutation.toName,
      event.peerName,
      event.eventId,
    );
    const clonedNodeId = this.cloneSubtree(
      event.folderId,
      mutation.repository,
      mutation.nodeId,
      event.eventId,
      new Map(),
    );
    const entryVersion = version(event.eventId, "conflict-entry");
    this.insertEntry(
      event.folderId,
      mutation.repository,
      mutation.toParentNodeId,
      generated,
      clonedNodeId,
      entryVersion,
      event.eventId,
    );
    const conflictPath = this.pathForNode(
      event.folderId,
      mutation.repository,
      clonedNodeId,
    );
    const conflict = this.recordConflict({
      event,
      originalPath:
        entry === null
          ? mutation.fromName
          : this.pathForEntry(event.folderId, entry),
      conflictPath,
      canonicalEventId: entry?.lastEventId ?? destination?.lastEventId ?? null,
      kind: "entry",
      manifestId: node.manifestId,
    });
    return {
      ...result(
        event,
        sequence,
        "conflict",
        clonedNodeId,
        conflictPath,
        entryVersion,
        node.contentVersion,
      ),
      conflictId: conflict.conflictId,
    };
  }

  private applyGit(
    event: EventRequest,
    mutation: GitMutation,
    sequence: number,
  ): EventResult {
    this.assertRepository(event.folderId, mutation.repository);
    const current = this.database
      .prepare(
        "SELECT manifest_id, version, last_event_id FROM git_states WHERE folder_id = ? AND repository = ?",
      )
      .get(event.folderId, mutation.repository) as
      Record<string, unknown> | undefined;
    if (current === undefined) throw new Error("Git state is missing");
    const currentVersion = nullableString(current.version, "Git version");
    const currentManifest = nullableString(current.manifest_id, "Git manifest");
    if (currentVersion === mutation.baseVersion) {
      if (currentManifest === mutation.manifestId) {
        return result(
          event,
          sequence,
          "coalesced",
          null,
          `.git`,
          null,
          currentVersion,
        );
      }
      const nextVersion = version(event.eventId, "git");
      this.database
        .prepare(
          `
          UPDATE git_states SET manifest_id = ?, version = ?, last_event_id = ?
          WHERE folder_id = ? AND repository = ?
        `,
        )
        .run(
          mutation.manifestId,
          nextVersion,
          event.eventId,
          event.folderId,
          mutation.repository,
        );
      return result(
        event,
        sequence,
        "canonical",
        null,
        `.git`,
        null,
        nextVersion,
      );
    }
    if (currentManifest === mutation.manifestId) {
      return result(
        event,
        sequence,
        "coalesced",
        null,
        `.git`,
        null,
        currentVersion,
      );
    }
    const conflict = this.recordConflict({
      event,
      originalPath: `.git`,
      conflictPath: null,
      canonicalEventId: nullableString(current.last_event_id, "Git event"),
      kind: "git",
      manifestId: mutation.manifestId,
    });
    return {
      ...result(event, sequence, "conflict", null, null, null, currentVersion),
      conflictId: conflict.conflictId,
    };
  }

  private createConflictClone(
    event: EventRequest,
    mutation: PutMutation,
    canonicalEntry: EntryRow,
    sequence: number,
    kind: "content" | "entry",
    requestedNodeId?: string,
  ): EventResult {
    const generated = this.availableConflictName(
      event.folderId,
      mutation.repository,
      canonicalEntry.parentNodeId,
      canonicalEntry.name,
      event.peerName,
      event.eventId,
    );
    const nodeId =
      requestedNodeId ??
      hashJson({ eventId: event.eventId, type: "conflict-node" });
    const entryVersion = version(event.eventId, "conflict-entry");
    const contentVersion = version(event.eventId, "conflict-content");
    this.insertNodeAndEntry(
      event,
      mutation,
      nodeId,
      canonicalEntry.parentNodeId,
      generated,
      entryVersion,
      contentVersion,
    );
    const conflictPath = this.pathForNode(
      event.folderId,
      mutation.repository,
      nodeId,
    );
    const conflict = this.recordConflict({
      event,
      originalPath: this.pathForEntry(event.folderId, canonicalEntry),
      conflictPath,
      canonicalEventId: canonicalEntry.lastEventId,
      kind,
      manifestId: mutation.manifestId,
    });
    return {
      ...result(
        event,
        sequence,
        "conflict",
        nodeId,
        conflictPath,
        entryVersion,
        contentVersion,
      ),
      conflictId: conflict.conflictId,
    };
  }

  private insertNodeAndEntry(
    event: EventRequest,
    mutation: PutMutation,
    nodeId: string,
    parentNodeId: string,
    name: string,
    entryVersion: string,
    contentVersion: string,
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO nodes(
          folder_id, repository, node_id, kind, manifest_id, content_version, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.folderId,
        mutation.repository,
        nodeId,
        mutation.nodeKind,
        mutation.manifestId,
        contentVersion,
        event.eventId,
      );
    this.insertEntry(
      event.folderId,
      mutation.repository,
      parentNodeId,
      name,
      nodeId,
      entryVersion,
      event.eventId,
    );
  }

  private insertEntry(
    folderId: string,
    repository: string,
    parentNodeId: string,
    name: string,
    nodeId: string,
    entryVersion: string,
    eventId: string,
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO entries(
          folder_id, repository, parent_node_id, name_key, display_name,
          node_id, entry_version, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        folderId,
        repository,
        parentNodeId,
        normalizedEntryKey(name),
        name,
        nodeId,
        entryVersion,
        eventId,
      );
  }

  private cloneSubtree(
    folderId: string,
    repository: string,
    sourceNodeId: string,
    eventId: string,
    mapped: Map<string, string>,
  ): string {
    const existing = mapped.get(sourceNodeId);
    if (existing !== undefined) return existing;
    const source = this.requiredNode(folderId, repository, sourceNodeId);
    const targetNodeId = hashJson({
      eventId,
      sourceNodeId,
      type: "subtree-clone",
    });
    mapped.set(sourceNodeId, targetNodeId);
    this.database
      .prepare(
        `
        INSERT INTO nodes(
          folder_id, repository, node_id, kind, manifest_id, content_version, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        folderId,
        repository,
        targetNodeId,
        source.kind,
        source.manifestId,
        version(eventId, `clone-content:${sourceNodeId}`),
        eventId,
      );
    if (source.kind === "directory") {
      const children = this.entriesUnder(folderId, repository, sourceNodeId);
      for (const child of children) {
        const clonedChild = this.cloneSubtree(
          folderId,
          repository,
          child.nodeId,
          eventId,
          mapped,
        );
        this.insertEntry(
          folderId,
          repository,
          targetNodeId,
          child.name,
          clonedChild,
          version(eventId, `clone-entry:${child.nodeId}`),
          eventId,
        );
      }
    }
    return targetNodeId;
  }

  private availableConflictName(
    folderId: string,
    repository: string,
    parentNodeId: string,
    originalName: string,
    peerName: string,
    eventId: string,
  ): string {
    for (const length of [8, 12, 16, 24, 32, 64]) {
      const candidate = conflictName(originalName, peerName, eventId, length);
      if (this.entryAt(folderId, repository, parentNodeId, candidate) === null)
        return candidate;
    }
    throw new Error("Unable to derive a unique conflict path");
  }

  private recordConflict(input: {
    readonly event: EventRequest;
    readonly originalPath: string;
    readonly conflictPath: string | null;
    readonly canonicalEventId: string | null;
    readonly kind: ConflictRecord["kind"];
    readonly manifestId: string | null;
  }): ConflictRecord {
    const conflictId = hashJson({
      folderId: input.event.folderId,
      eventId: input.event.eventId,
      kind: input.kind,
      conflictPath: input.conflictPath,
    });
    const record: ConflictRecord = {
      conflictId,
      folderId: input.event.folderId,
      repository: input.event.mutation.repository,
      originalPath: input.originalPath,
      conflictPath: input.conflictPath,
      canonicalEventId: input.canonicalEventId,
      conflictEventId: input.event.eventId,
      peerName: input.event.peerName,
      kind: input.kind,
      manifestId: input.manifestId,
      createdAt: input.event.createdAt,
    };
    this.database
      .prepare(
        "INSERT OR IGNORE INTO conflicts(conflict_id, folder_id, repository, created_at, record_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        conflictId,
        input.event.folderId,
        input.event.mutation.repository,
        input.event.createdAt,
        JSON.stringify(record),
      );
    return record;
  }

  private node(
    folderId: string,
    repository: string,
    nodeId: string,
  ): NodeRow | null {
    const row = this.database
      .prepare(
        `
        SELECT repository, node_id, kind, manifest_id, content_version, last_event_id
        FROM nodes WHERE folder_id = ? AND repository = ? AND node_id = ?
      `,
      )
      .get(folderId, repository, nodeId);
    return row === undefined ? null : parseNodeRow(row);
  }

  private requiredNode(
    folderId: string,
    repository: string,
    nodeId: string,
  ): NodeRow {
    const node = this.node(folderId, repository, nodeId);
    if (node === null) throw new Error(`Unknown node: ${nodeId}`);
    return node;
  }

  private entryByNode(
    folderId: string,
    repository: string,
    nodeId: string,
  ): EntryRow | null {
    const row = this.database
      .prepare(
        `
        SELECT repository, parent_node_id, name_key, display_name, node_id,
          entry_version, last_event_id
        FROM entries WHERE folder_id = ? AND repository = ? AND node_id = ?
      `,
      )
      .get(folderId, repository, nodeId);
    return row === undefined ? null : parseEntryRow(row);
  }

  private entryAt(
    folderId: string,
    repository: string,
    parentNodeId: string,
    name: string,
  ): EntryRow | null {
    const row = this.database
      .prepare(
        `
        SELECT repository, parent_node_id, name_key, display_name, node_id,
          entry_version, last_event_id
        FROM entries WHERE folder_id = ? AND repository = ?
          AND parent_node_id = ? AND name_key = ?
      `,
      )
      .get(folderId, repository, parentNodeId, normalizedEntryKey(name));
    return row === undefined ? null : parseEntryRow(row);
  }

  private entriesUnder(
    folderId: string,
    repository: string,
    parentNodeId: string,
  ): readonly EntryRow[] {
    return this.database
      .prepare(
        `
        SELECT repository, parent_node_id, name_key, display_name, node_id,
          entry_version, last_event_id
        FROM entries WHERE folder_id = ? AND repository = ? AND parent_node_id = ?
        ORDER BY name_key
      `,
      )
      .all(folderId, repository, parentNodeId)
      .map(parseEntryRow);
  }

  private pathForEntry(folderId: string, entry: EntryRow): string {
    const parent = this.pathForNode(
      folderId,
      entry.repository,
      entry.parentNodeId,
    );
    return parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
  }

  private pathForNode(
    folderId: string,
    repository: string,
    nodeId: string,
  ): string {
    const root = this.database
      .prepare(
        "SELECT root_node_id FROM repositories WHERE folder_id = ? AND repository = ?",
      )
      .get(folderId, repository) as Record<string, unknown> | undefined;
    if (root === undefined)
      throw new Error(`Unknown repository: ${repository}`);
    if (requiredString(root.root_node_id, "Root node") === nodeId) return "";
    const parts: string[] = [];
    const visited = new Set<string>();
    let cursor = nodeId;
    while (cursor !== requiredString(root.root_node_id, "Root node")) {
      if (visited.has(cursor)) throw new Error("Hub entry cycle detected");
      visited.add(cursor);
      const entry = this.entryByNode(folderId, repository, cursor);
      if (entry === null) throw new Error(`Node has no live entry: ${cursor}`);
      parts.push(entry.name);
      cursor = entry.parentNodeId;
    }
    return parts.reverse().join("/");
  }

  private assertRepository(folderId: string, repository: string): void {
    if (
      !this.getFolder(folderId).repositories.some(
        (value) => value.name === repository,
      )
    )
      throw new Error(`Unknown repository: ${repository}`);
  }

  private assertDirectoryNode(
    folderId: string,
    repository: string,
    nodeId: string,
  ): void {
    const node = this.requiredNode(folderId, repository, nodeId);
    if (node.kind !== "directory")
      throw new Error("Parent node is not a directory");
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

function validateFolder(folder: FolderRecord): void {
  if (
    folder.schemaVersion !== schemaVersion ||
    folder.protocolVersion !== protocolVersion ||
    folder.folderId.length < 8 ||
    folder.folderName.trim().length === 0 ||
    folder.repositories.length === 0
  ) {
    throw new Error("Invalid folder record");
  }
  const names = new Set<string>();
  for (const repository of folder.repositories) {
    normalizeRelativePath(repository.name);
    if (names.has(repository.name)) throw new Error("Duplicate repository");
    names.add(repository.name);
  }
}

function validateEvent(event: EventRequest): void {
  if (
    event.schemaVersion !== schemaVersion ||
    event.eventId.length < 8 ||
    event.folderId.length < 8 ||
    event.peerId.length < 8 ||
    event.peerName.trim().length === 0 ||
    !Number.isSafeInteger(event.peerSequence) ||
    event.peerSequence <= 0
  ) {
    throw new Error("Invalid event");
  }
  validateMutation(event.mutation);
}

function validateMutation(mutation: Mutation): void {
  normalizeRelativePath(mutation.repository);
  switch (mutation.kind) {
    case "put":
      normalizeRelativePath(mutation.name);
      if (mutation.name.includes("/"))
        throw new Error("Entry name contains slash");
      if (mutation.nodeKind === "directory" && mutation.manifestId !== null)
        throw new Error("Ordinary directory cannot have a manifest");
      if (mutation.nodeKind !== "directory" && mutation.manifestId === null)
        throw new Error("File manifest is missing");
      return;
    case "delete":
      normalizeRelativePath(mutation.name);
      return;
    case "rename":
      normalizeRelativePath(mutation.fromName);
      normalizeRelativePath(mutation.toName);
      return;
    case "git-state":
      return;
  }
}

function validateEventObjects(mutation: Mutation, store: ObjectStore): void {
  if (mutation.kind === "put" && mutation.manifestId !== null) {
    for (const id of referencedObjects(mutation.manifestId, store)) {
      if (!store.has(id)) throw new Error(`Missing referenced object: ${id}`);
    }
  }
  if (mutation.kind === "git-state") {
    const manifest = store.getManifest(mutation.manifestId);
    if (manifest.type !== "tree")
      throw new Error("Git state must reference a tree");
    for (const id of referencedObjects(mutation.manifestId, store)) {
      if (!store.has(id)) throw new Error(`Missing Git object: ${id}`);
    }
  }
}

function parseEntry(value: unknown): EntryRecord {
  const input = value as Record<string, unknown>;
  return {
    repository: requiredString(input.repository, "Repository"),
    parentNodeId: requiredString(input.parent_node_id, "Parent node"),
    name: requiredString(input.display_name, "Entry name"),
    nodeId: requiredString(input.node_id, "Node ID"),
    entryVersion: requiredString(input.entry_version, "Entry version"),
  };
}

function parseEntryRow(value: unknown): EntryRow {
  const input = value as Record<string, unknown>;
  return {
    ...parseEntry(value),
    nameKey: requiredString(input.name_key, "Entry key"),
    lastEventId: requiredString(input.last_event_id, "Entry event"),
  };
}

function parseNode(value: unknown): NodeRecord {
  const input = value as Record<string, unknown>;
  const kind = parseKind(input.kind);
  return {
    repository: requiredString(input.repository, "Repository"),
    nodeId: requiredString(input.node_id, "Node ID"),
    kind,
    manifestId: nullableString(input.manifest_id, "Manifest ID"),
    contentVersion: requiredString(input.content_version, "Content version"),
  };
}

function parseNodeRow(value: unknown): NodeRow {
  const input = value as Record<string, unknown>;
  return {
    ...parseNode(value),
    lastEventId: requiredString(input.last_event_id, "Node event"),
  };
}

function parseGitState(value: unknown): GitStateRecord {
  const input = value as Record<string, unknown>;
  return {
    repository: requiredString(input.repository, "Repository"),
    manifestId: nullableString(input.manifest_id, "Git manifest"),
    version: nullableString(input.version, "Git version"),
  };
}

function parseStoredResult(value: unknown): EventResult {
  const input = value as Record<string, unknown>;
  const json = input.result_json;
  if (typeof json !== "string") throw new Error("Stored event is incomplete");
  return JSON.parse(json) as EventResult;
}

function parseKind(value: unknown): NodeKind {
  if (value === "directory" || value === "regular" || value === "symlink")
    return value;
  throw new Error("Invalid node kind");
}

function version(eventId: string, purpose: string): string {
  return hashJson({ eventId, purpose });
}

function result(
  event: EventRequest,
  hubSequence: number,
  disposition: EventResult["disposition"],
  nodeId: string | null,
  path: string | null,
  entryVersion: string | null,
  contentVersion: string | null,
): EventResult {
  return {
    eventId: event.eventId,
    hubSequence,
    disposition,
    repository: event.mutation.repository,
    nodeId,
    path,
    entryVersion,
    contentVersion,
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
