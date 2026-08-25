# CodeFolderSync V3 data model

The executable contracts are `codefoldersync/src/v3/types.ts`, the SQLite initialization in `state.ts` and `hub.ts`, and the manifest validation in `objects.ts` and `catalog.ts`.

## Versions

Both `schemaVersion` and `protocolVersion` are `3`. V1 and V2 configuration, hubs, manifests, and RPC are rejected. V3 uses fresh folder, state, hub, event, and key identities.

## Configuration

`ProductConfig` contains revision, folder identity, local root/state projection, local peer identity, hub, authority public key, enrolled peers and roots, ignore digest, lifecycle, backup witness, service timing, and authority signature.

The authority signature covers portable desired state. The local root must equal the root in that peer's signed record. Targets are saved mode read-only; a changed signed field fails verification and cannot publish.

## Namespace manifest

`NamespaceManifest` contains:

- folder and ignore identity;
- sorted recursive catalog entries;
- sorted Git boundaries;
- a diagnostic creation time;
- an independently recomputed semantic digest.

A catalog entry contains path, parent path, parent node ID, display and portable name, stable node ID, kind, manifest ID, executable meaning, and local filesystem observations. The synthetic root identity is `$root`. Manifest validation requires every non-root entry to name an existing directory parent. Device, inode, timestamps, and size are rename/capture hints and are excluded from cross-peer semantic equality.

The semantic digest covers accepted paths, parent identities, stable node IDs, kinds, content manifests, executable meaning, and Git boundaries. Target verification rescans with source node IDs as its accepted identity baseline.

## Mutation events

Each signed snapshot carries a monotonically increasing peer sequence and a deterministic ordered mutation list derived from the accepted base and proposed namespace. Mutation kinds are `put-node`, `move-entry`, `delete-entry`, `restore-entry`, and `git-state`.

Every mutation records folder, peer, event and node identity; peer sequence; base configuration revision; base and resulting entry/publisher versions; affected paths; and the complete immutable object closure needed for the resulting node. Event history therefore preserves both whole-checkpoint evidence and explicit causal node operations. A restore may reuse a retained tombstoned node ID only when the same path and content version reappear.

## Publisher manifests

Every object ID is SHA-256 of exact bytes.

- A regular manifest records executable meaning, byte length, whole-file digest, and ordered immutable chunks.
- A symlink manifest records exact target text and its digest.
- A tree manifest records sorted child name, kind, and manifest. It represents transactional Git metadata and immutable normal directory-conflict evidence.

Objects are stored in SQLite `WITHOUT ROWID` tables with WAL and full synchronous commits. Reads always verify their digest.

## Git boundaries

A boundary records stable boundary ID, worktree-relative path, contained physical Git path, boundary kind, and tree-manifest ID. Kinds are physical, contained indirection, and submodule indirection. External targets are not representable.

## Local SQLite state

| Table             | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `meta`            | Accepted sequence and baseline digest                         |
| `catalog`         | Rebuildable current stable-node observations                  |
| `catalog_history` | Accepted placement/publisher version hashes and tombstones    |
| `outbox`          | Exact signed event and object closure pending acknowledgement |
| `journals`        | Rename, snapshot-apply, adoption, and cutover intent          |
| `conflicts`       | Local recovery and visible conflict records                   |

The complete accepted baseline snapshot also lives as owner-only `baseline.json` so three-way merge can distinguish local, remote, and concurrent change.

## Hub SQLite state

| Table              | Purpose                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `folders`          | Accepted config revision, sequence, and current snapshot                                              |
| `events`           | Immutable event/barrier identity, payload hash, peer sequence, mutation list, digest and global order |
| `conflicts`        | Fleet-visible retained conflict records                                                               |
| `adoption_targets` | Peer, source generation/digest, and verification time                                                 |

An event ID retry returns its stored sequence only when the payload hash matches. Changed payload reuse is rejected. A signed normal snapshot includes its explicit mutations and conflict records; the hub inserts its event, current checkpoint, mutation history, and conflicts in one transaction.

## Adoption plan

The target-local plan records adoption ID, source sequence/digest, target peer/digest, creation time, sanitized summary, and path classifications inside an AES-256-GCM envelope. Its independent mode-0600 key stays in the target's machine-local key directory. Apply accepts only the exact target and source generations named by that authenticated plan.
