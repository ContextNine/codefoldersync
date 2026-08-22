import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { hashJson } from "../v2/hash.js";
import { manifestObjectIds, validateNamespaceManifest } from "./catalog.js";
import { signedConfigPayload, verifyConfig, verifyPayload } from "./config.js";
import { ObjectStore, referencedObjects } from "./objects.js";
import { deriveMutations } from "./mutations.js";
import {
  protocolVersion,
  type ConflictRecord,
  type HubCheckpoint,
  type NamespaceManifest,
  type ProductConfig,
  type SignedAdoptionVerification,
  type SignedConflict,
  type SignedSnapshot,
} from "./types.js";

export class HubStore implements Disposable {
  public readonly root: string;
  public readonly objects: ObjectStore;
  private readonly database: DatabaseSync;

  public constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(this.root, "hub.sqlite"));
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        folder_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        snapshot_json TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        peer_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        peer_sequence INTEGER,
        mutations_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_folder_sequence ON events(folder_id, sequence);
      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS adoption_targets (
        folder_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        source_digest TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY(folder_id, peer_id)
      ) WITHOUT ROWID;
    `);
    this.objects = new ObjectStore(join(this.root, "objects"));
  }

  public [Symbol.dispose](): void {
    this.objects[Symbol.dispose]();
    this.database.close();
  }

  public hello(): number {
    return protocolVersion;
  }

  public createFolder(config: ProductConfig): void {
    verifyConfig(config);
    if (config.authority.peerId !== config.peerId)
      throw new Error("Only the authority can create a V3 folder");
    this.database
      .prepare(
        "INSERT INTO folders(folder_id,revision,sequence,config_json,snapshot_json) VALUES (?,?,0,?,NULL)",
      )
      .run(config.folderId, config.revision, JSON.stringify(config));
  }

  public checkpoint(folderId: string): HubCheckpoint {
    const row = this.database
      .prepare(
        "SELECT revision,sequence,config_json,snapshot_json FROM folders WHERE folder_id = ?",
      )
      .get(folderId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`Unknown folder: ${folderId}`);
    const config = JSON.parse(String(row.config_json)) as ProductConfig;
    verifyConfig(config);
    const snapshot =
      row.snapshot_json === null
        ? null
        : (JSON.parse(String(row.snapshot_json)) as NamespaceManifest);
    if (snapshot !== null) validateNamespaceManifest(snapshot);
    return { sequence: Number(row.sequence), config, snapshot };
  }

  public updateConfig(
    config: ProductConfig,
    expectedRevision: number,
  ): ProductConfig {
    verifyConfig(config);
    if (config.revision !== expectedRevision + 1)
      throw new Error("Configuration revision must advance exactly once");
    const current = this.checkpoint(config.folderId).config;
    if (current.revision !== expectedRevision)
      throw new Error("Configuration compare-and-swap failed");
    if (
      current.authority.publicKey !== config.authority.publicKey ||
      current.authority.peerId !== config.authority.peerId
    )
      throw new Error("Configuration authority cannot change in place");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const checkpoint = this.checkpoint(config.folderId);
      let eventPrefix = "authority-config";
      if (current.lifecycle === "adoption" && config.lifecycle === "normal") {
        if (checkpoint.snapshot === null)
          throw new Error("Adoption barrier requires a sealed source snapshot");
        const verified = new Set(
          this.database
            .prepare(
              "SELECT peer_id FROM adoption_targets WHERE folder_id=? AND source_sequence=? AND source_digest=?",
            )
            .all(
              config.folderId,
              checkpoint.sequence,
              checkpoint.snapshot.digest,
            )
            .map((row) => String((row as { peer_id: unknown }).peer_id)),
        );
        const missing = config.peers
          .filter(
            (peer) =>
              peer.peerId !== config.authority.peerId && peer.role !== "hub",
          )
          .map((peer) => peer.peerId)
          .filter((peerId) => !verified.has(peerId));
        if (missing.length > 0)
          throw new Error(
            `Adoption barrier has unverified peers: ${missing.join(", ")}`,
          );
        eventPrefix = "adoption-barrier";
      } else if (current.lifecycle !== config.lifecycle) {
        throw new Error(
          "Lifecycle transitions are one-way from adoption to normal",
        );
      }
      const payloadHash = hashJson(signedConfigPayload(config));
      const eventId = `${eventPrefix}:${config.revision}:${payloadHash}`;
      const event = this.database
        .prepare(
          "INSERT INTO events(folder_id,event_id,peer_id,payload_hash,snapshot_digest,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          config.folderId,
          eventId,
          config.authority.peerId,
          payloadHash,
          checkpoint.snapshot?.digest ?? "0".repeat(64),
          new Date().toISOString(),
        );
      const eventSequence = Number(event.lastInsertRowid);
      const updated = this.database
        .prepare(
          "UPDATE folders SET revision=?, config_json=?, sequence=? WHERE folder_id=? AND revision=?",
        )
        .run(
          config.revision,
          JSON.stringify(config),
          eventSequence,
          config.folderId,
          expectedRevision,
        );
      if (Number(updated.changes) !== 1)
        throw new Error("Configuration compare-and-swap failed");
      this.database.exec("COMMIT");
      return config;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public acceptSnapshot(input: SignedSnapshot): number {
    validateNamespaceManifest(input.snapshot);
    this.validateSnapshotConflicts(input);
    const payloadHash = hashJson(snapshotPayload(input));
    const existing = this.database
      .prepare("SELECT payload_hash, sequence FROM events WHERE event_id = ?")
      .get(input.eventId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (String(existing.payload_hash) !== payloadHash)
        throw new Error("Event ID was reused with a different payload");
      return Number(existing.sequence);
    }
    const checkpoint = this.checkpoint(input.snapshot.folderId);
    if (input.baseSequence !== checkpoint.sequence)
      throw new Error("Snapshot compare-and-swap failed");
    const peer = checkpoint.config.peers.find(
      (value) => value.peerId === input.peerId,
    );
    if (peer === undefined) throw new Error("Publishing peer is not enrolled");
    if (
      checkpoint.config.lifecycle === "adoption" &&
      input.peerId !== checkpoint.config.authority.peerId
    )
      throw new Error("Targets cannot publish during adoption");
    if (
      checkpoint.config.lifecycle === "adoption" &&
      input.conflicts.length > 0
    )
      throw new Error("Adoption source snapshots cannot contain conflicts");
    if (!verifyPayload(snapshotPayload(input), input.signature, peer.publicKey))
      throw new Error("Peer snapshot signature is invalid");
    this.validateSnapshotMutations(input, checkpoint);
    const required = new Set(manifestObjectIds(input.snapshot, this.objects));
    for (const conflict of input.conflicts)
      if (conflict.manifestId !== null)
        for (const id of referencedObjects(conflict.manifestId, this.objects))
          required.add(id);
    for (const id of required)
      if (!this.objects.has(id))
        throw new Error(`Hub object is missing: ${id}`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare(
          "INSERT INTO events(folder_id,event_id,peer_id,payload_hash,snapshot_digest,peer_sequence,mutations_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          input.snapshot.folderId,
          input.eventId,
          input.peerId,
          payloadHash,
          input.snapshot.digest,
          input.peerSequence,
          JSON.stringify(input.mutations),
          new Date().toISOString(),
        );
      const sequence = Number(result.lastInsertRowid);
      const changed = this.database
        .prepare(
          "UPDATE folders SET sequence=?, snapshot_json=? WHERE folder_id=? AND sequence=?",
        )
        .run(
          sequence,
          JSON.stringify(input.snapshot),
          input.snapshot.folderId,
          input.baseSequence,
        );
      if (Number(changed.changes) !== 1)
        throw new Error("Snapshot compare-and-swap failed");
      for (const conflict of input.conflicts)
        this.insertConflict(
          input.snapshot.folderId,
          `${input.eventId}:conflict:${conflict.conflictId}`,
          conflict,
          hashJson(conflict),
        );
      this.database.exec("COMMIT");
      return sequence;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public addConflict(input: SignedConflict): void {
    const checkpoint = this.checkpoint(input.folderId);
    const peer = checkpoint.config.peers.find(
      (value) => value.peerId === input.peerId,
    );
    if (peer === undefined) throw new Error("Conflict peer is not enrolled");
    if (
      input.conflict.peerId !== input.peerId ||
      !verifyPayload(conflictPayload(input), input.signature, peer.publicKey)
    )
      throw new Error("Conflict signature is invalid");
    if (
      checkpoint.config.lifecycle === "adoption" &&
      (input.peerId === checkpoint.config.authority.peerId ||
        !["adoption", "git"].includes(input.conflict.kind))
    )
      throw new Error("Only target-originated adoption conflicts are accepted");
    const payloadHash = hashJson(conflictPayload(input));
    this.insertConflict(
      input.folderId,
      input.eventId,
      input.conflict,
      payloadHash,
    );
  }

  public conflicts(folderId: string): readonly ConflictRecord[] {
    return this.database
      .prepare(
        "SELECT json FROM conflicts WHERE folder_id=? ORDER BY conflict_id",
      )
      .all(folderId)
      .map(
        (row) =>
          JSON.parse(String((row as { json: unknown }).json)) as ConflictRecord,
      );
  }

  public recordAdoptionVerification(input: SignedAdoptionVerification): void {
    const checkpoint = this.checkpoint(input.folderId);
    if (
      checkpoint.sequence !== input.sourceSequence ||
      checkpoint.snapshot?.digest !== input.sourceDigest
    )
      throw new Error("Adoption verification is stale");
    if (checkpoint.config.lifecycle !== "adoption")
      throw new Error("Adoption verification is closed after cutover");
    const peer = checkpoint.config.peers.find(
      (value) => value.peerId === input.peerId,
    );
    if (peer === undefined) throw new Error("Adoption target is not enrolled");
    if (input.peerId === checkpoint.config.authority.peerId)
      throw new Error("The source authority is not an adoption target");
    if (
      !verifyPayload(
        adoptionVerificationPayload(input),
        input.signature,
        peer.publicKey,
      )
    )
      throw new Error("Adoption verification signature is invalid");
    const payloadHash = hashJson(adoptionVerificationPayload(input));
    const existingEvent = this.database
      .prepare("SELECT payload_hash FROM adoption_targets WHERE event_id=?")
      .get(input.eventId) as { readonly payload_hash?: unknown } | undefined;
    if (existingEvent !== undefined) {
      if (String(existingEvent.payload_hash) !== payloadHash)
        throw new Error(
          "Adoption verification ID was reused with a different payload",
        );
      return;
    }
    const existingPeer = this.database
      .prepare(
        "SELECT source_sequence,source_digest FROM adoption_targets WHERE folder_id=? AND peer_id=?",
      )
      .get(input.folderId, input.peerId) as
      | { readonly source_sequence?: unknown; readonly source_digest?: unknown }
      | undefined;
    if (existingPeer !== undefined) {
      if (
        Number(existingPeer.source_sequence) !== input.sourceSequence ||
        String(existingPeer.source_digest) !== input.sourceDigest
      )
        throw new Error(
          "Adoption target verification changed after acceptance",
        );
      return;
    }
    this.database
      .prepare(
        "INSERT INTO adoption_targets(folder_id,peer_id,event_id,payload_hash,source_sequence,source_digest,verified_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.folderId,
        input.peerId,
        input.eventId,
        payloadHash,
        input.sourceSequence,
        input.sourceDigest,
        new Date().toISOString(),
      );
  }

  public verifiedAdoptionPeers(folderId: string): readonly string[] {
    return this.database
      .prepare(
        "SELECT peer_id FROM adoption_targets WHERE folder_id=? ORDER BY peer_id",
      )
      .all(folderId)
      .map((row) => String((row as { peer_id: unknown }).peer_id));
  }

  public history(folderId: string): readonly Record<string, unknown>[] {
    return this.database
      .prepare(
        "SELECT sequence,event_id,peer_id,peer_sequence,snapshot_digest,mutations_json,created_at FROM events WHERE folder_id=? ORDER BY sequence",
      )
      .all(folderId) as readonly Record<string, unknown>[];
  }

  private validateSnapshotConflicts(input: SignedSnapshot): void {
    const conflictIds = new Set<string>();
    for (const conflict of input.conflicts) {
      if (conflictIds.has(conflict.conflictId))
        throw new Error(
          `Snapshot contains duplicate conflict: ${conflict.conflictId}`,
        );
      conflictIds.add(conflict.conflictId);
      if (conflict.peerId !== input.peerId)
        throw new Error("Snapshot conflict peer does not match publisher");
      if (!["normal", "git"].includes(conflict.kind))
        throw new Error(
          "Snapshots can contain only normal synchronization conflicts",
        );
    }
  }

  private validateSnapshotMutations(
    input: SignedSnapshot,
    checkpoint: HubCheckpoint,
  ): void {
    if (!Number.isSafeInteger(input.peerSequence) || input.peerSequence < 1)
      throw new Error("Snapshot peer sequence is invalid");
    const previous = this.database
      .prepare(
        "SELECT MAX(peer_sequence) AS peer_sequence FROM events WHERE folder_id=? AND peer_id=?",
      )
      .get(input.snapshot.folderId, input.peerId) as
      { readonly peer_sequence?: unknown } | undefined;
    if (
      previous?.peer_sequence !== null &&
      previous?.peer_sequence !== undefined &&
      input.peerSequence <= Number(previous.peer_sequence)
    )
      throw new Error("Snapshot peer sequence did not advance");
    const expected = deriveMutations({
      config: {
        folderId: input.snapshot.folderId,
        peerId: input.peerId,
        revision: checkpoint.config.revision,
      },
      eventId: input.eventId,
      peerSequence: input.peerSequence,
      base: checkpoint.snapshot,
      next: input.snapshot,
      objects: this.objects,
      restoredNodeIds: this.deletedNodeIds(input.snapshot.folderId),
    });
    if (JSON.stringify(expected) !== JSON.stringify(input.mutations))
      throw new Error("Snapshot mutation list does not match its checkpoint");
  }

  private deletedNodeIds(folderId: string): ReadonlySet<string> {
    const result = new Set<string>();
    for (const row of this.database
      .prepare(
        "SELECT mutations_json FROM events WHERE folder_id=? AND mutations_json IS NOT NULL ORDER BY sequence",
      )
      .all(folderId)) {
      const mutations = JSON.parse(
        String((row as { readonly mutations_json: unknown }).mutations_json),
      ) as unknown;
      if (!Array.isArray(mutations))
        throw new Error("Stored snapshot mutations are invalid");
      for (const mutation of mutations)
        if (
          typeof mutation === "object" &&
          mutation !== null &&
          (mutation as { readonly kind?: unknown }).kind === "delete-entry" &&
          typeof (mutation as { readonly nodeId?: unknown }).nodeId === "string"
        )
          result.add(String((mutation as { readonly nodeId: unknown }).nodeId));
    }
    return result;
  }

  private insertConflict(
    folderId: string,
    eventId: string,
    conflict: ConflictRecord,
    payloadHash: string,
  ): void {
    const existingEvent = this.database
      .prepare("SELECT payload_hash FROM conflicts WHERE event_id=?")
      .get(eventId) as { readonly payload_hash?: unknown } | undefined;
    if (existingEvent !== undefined) {
      if (String(existingEvent.payload_hash) !== payloadHash)
        throw new Error(
          "Conflict event ID was reused with a different payload",
        );
      return;
    }
    const existingConflict = this.database
      .prepare("SELECT payload_hash FROM conflicts WHERE conflict_id=?")
      .get(conflict.conflictId) as
      { readonly payload_hash?: unknown } | undefined;
    if (existingConflict !== undefined) {
      if (String(existingConflict.payload_hash) !== payloadHash)
        throw new Error("Conflict ID was reused with a different payload");
      return;
    }
    this.database
      .prepare(
        "INSERT INTO conflicts(conflict_id,folder_id,event_id,payload_hash,json) VALUES (?,?,?,?,?)",
      )
      .run(
        conflict.conflictId,
        folderId,
        eventId,
        payloadHash,
        JSON.stringify(conflict),
      );
  }
}

export function snapshotPayload(input: SignedSnapshot): unknown {
  return {
    snapshot: input.snapshot,
    peerId: input.peerId,
    baseSequence: input.baseSequence,
    eventId: input.eventId,
    peerSequence: input.peerSequence,
    mutations: input.mutations,
    conflicts: input.conflicts,
  };
}

export function conflictPayload(input: SignedConflict): unknown {
  return {
    folderId: input.folderId,
    peerId: input.peerId,
    eventId: input.eventId,
    conflict: input.conflict,
  };
}

export function adoptionVerificationPayload(
  input: SignedAdoptionVerification,
): unknown {
  return {
    folderId: input.folderId,
    peerId: input.peerId,
    eventId: input.eventId,
    sourceSequence: input.sourceSequence,
    sourceDigest: input.sourceDigest,
  };
}
