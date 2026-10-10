# CodeFolderSync V3 data model

The executable contracts are `codefoldersync/src/v3/types.ts`, the SQLite initialization in `state.ts` and `hub.ts`, and the manifest validation in `objects.ts` and `catalog.ts`.

## Versions

Both `schemaVersion` and `protocolVersion` are `3`. V1 and V2 configuration, hubs, manifests, and RPC are rejected. V3 uses fresh folder, state, hub, event, and key identities.

## Configuration

`ProductConfig` contains revision, folder identity, local root/state projection, local peer identity, hub, authority public key, enrolled peers and roots, ignore digest, signed synchronization policy, lifecycle, backup witness, service timing, and authority signature. The policy selects default-branch gating or an explicit file allowlist and records plaintext ENV consent.

The authority signature covers portable desired state. The local root must equal the root in that peer's signed record. Targets are saved mode read-only; a changed signed field fails verification and cannot publish.

## Namespace manifest

`NamespaceManifest` contains:

- folder and ignore identity;
- sorted recursive catalog entries;
- sorted repository identity, branch, and HEAD contexts for default-branch scope;
- a diagnostic creation time;
- an independently recomputed semantic digest.

A catalog entry contains path, parent path, parent node ID, display and portable name, stable node ID, kind, manifest ID, executable meaning, and local filesystem observations. The synthetic root identity is `$root`. Manifest validation requires every non-root entry to name an existing directory parent. Device, inode, timestamps, and size are rename/capture hints and are excluded from cross-peer semantic equality.

The semantic digest covers accepted paths, parent identities, stable node IDs, kinds, content manifests, executable meaning, and repository contexts. Selected-file snapshots use an empty repository-context list. Target verification rescans with source node IDs as its accepted identity baseline.

## Mutation events

Each signed snapshot carries a monotonically increasing peer sequence and a deterministic ordered mutation list derived from the accepted base and proposed namespace. Mutation kinds are `put-node`, `move-entry`, `delete-entry`, `restore-entry`, and `git-state`.

Every mutation records folder, peer, event and node identity; peer sequence; base configuration revision; base and resulting entry/publisher versions; affected paths; and the complete immutable object closure needed for the resulting node. Event history therefore preserves both whole-checkpoint evidence and explicit causal node operations. A restore may reuse a retained tombstoned node ID only when the same path and content version reappear.

## Publisher manifests

Every object ID is SHA-256 of exact bytes.

- A regular manifest records executable meaning, byte length, whole-file digest, and ordered immutable chunks.
- A symlink manifest records exact target text and its digest.
- A tree manifest records sorted child name, kind, and manifest. It represents immutable included directory-conflict evidence, never local-only siblings.

Objects are stored in SQLite `WITHOUT ROWID` tables with WAL and full synchronous commits. Reads always verify their digest.

## Local Git context

Git metadata stays local. The signed policy validator rejects a nonempty Git-boundary list. Default-branch snapshots record each repository's path, root-commit identity hash, branch, and exact HEAD. Selected-file discovery needs only contained metadata exclusions and does not require a committed or idle checkout. External Git targets remain unsupported. See [synchronization policies](sync-policies.md) for the current development gates.

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

With independently suspended repositories, this file retains their previous accepted local entries and contexts while eligible entries advance. The global cursor still names the latest accepted hub event; it does not imply that every suspended scope accepted that event. The derived catalog likewise retains suspended observations.

A normal apply journal stores current/desired eligible manifests, the complete hub event's accepted digest and sequence, the recovery root, and its repository scope. Scope names all discovered/enrolled roots, eligible contexts, suspended reasons, and enclosing checkout guards. Recovery validates that journal scope and proves the complete accepted digest against hub history before applying its eligible projection.

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
