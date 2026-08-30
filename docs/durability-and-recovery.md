# CodeFolderSync V3 durability and recovery

## Persistence domains

V3 has four durability domains: the live root, peer state, hub metadata, and hub objects. Peer and hub SQLite use WAL and `synchronous=FULL`. The root and peer state must share a filesystem so recovery moves and final placement use atomic rename.

Peer state contains `state.sqlite`, immutable objects, staging, adoption recovery, apply recovery, logs, keys, encrypted plans, and `baseline.json`. It is owner-only and outside the synchronized root. Detailed adoption paths are encrypted with a target-local AES-256-GCM key; hub adoption records contain only path hashes and `local-only` recovery markers.

## Capture

Regular files are statted before and after bounded reads. Device, inode, size, timestamps, or mode change rejects a torn capture. Symlinks are read as target text and rechecked. Immutable bytes validate their proposed SHA-256 ID before insertion.

An interrupted capture can leave unreachable immutable objects. That is safe retained data, not an accepted mutation.

## Durable publication

Publication order is:

```text
verified local objects
-> exact signed snapshot, conflicts, and object closure in durable outbox
-> verified hub objects
-> accepted hub event
-> outbox acknowledgement
-> local baseline/cursor
```

The hub verifies the peer signature over the snapshot, explicit mutations, peer sequence, and normal conflicts, then commits them in one SQLite transaction. If an acknowledgement is lost after commit, retry returns the original event sequence. If a different peer advanced the hub first, the stale serialization is replaced only after the live proposal remains available for three-way merge.

## Adoption recovery

Before adoption replaces or removes a target path, the live object or subtree is renamed to:

```text
<state>/adoption-recovery/<adoption-id>/<original-relative-path>
```

The conflict record binds target peer, original path, recovery path, retained manifest where available, reason, and source generation through the adoption plan. Recovery evidence is not automatically synchronized or deleted.

`codefoldersync recover <id> --to <absent-path>` copies retained evidence. It does not consume the recovery original.

## Apply recovery and journals

Normal replacement/removal moves the prior live path to a unique `apply-recovery` generation. Every rename or recovery move first writes a SQLite journal with exact source and destination. A higher-level `snapshot-apply` journal binds the accepted sequence, pre-apply snapshot, desired snapshot, and recovery generation. Rename cycles stage every moving root under deterministic same-filesystem paths before any destination is occupied.

Startup validates that both paths remain within the root or state directory. If source is absent and destination exists, it restores the source. If source exists, it closes the journal and reconciliation decides the accepted result.

New materialization happens in same-filesystem staging, verifies its manifest, and renames into place. Git staging additionally runs `git fsck --full` before and after swap. Restart accepts only a live tree composed of the recorded pre-apply and desired states; an unrelated edit stops recovery without overwriting it. Source seal and cutover likewise retain durable intent across upload, unknown acknowledgement, hub acceptance, and local projection boundaries. Authority creation, peer enrollment, and peer configuration projection have their own exact journals so an interruption before or after hub/config acknowledgement resumes without generating a second folder or peer identity.

The Linux acceptance test uses a native preload shim so production `write` and `fsync` calls receive `ENOSPC` and `EIO` from the operating-system boundary. Both failures leave the sync inconclusive, keep the previous bytes under `apply-recovery`, and retain partial staging outside the live root. A clean retry must converge and pass full verification without removing the recovery copy.

## Baseline recovery

The owner-only baseline snapshot and catalog observations are rebuildable from the live tree plus hub checkpoint. Losing catalog rows may reduce rename inference but does not remove content. Losing the baseline requires conservative remote reconciliation rather than guessing concurrency.

## Failure matrix

| Failure                      | Durable evidence                         | Next action                        |
| ---------------------------- | ---------------------------------------- | ---------------------------------- |
| Torn capture                 | Possibly unreachable local objects       | Reject and force rescan            |
| Hub unavailable before event | Live tree, objects, outbox               | Retry exact event                  |
| Commit with lost response    | Hub event and local outbox               | Idempotent retry                   |
| Stale CAS                    | Live proposal and newer hub checkpoint   | Three-way merge                    |
| Adoption interruption        | Plan, journals, recovery objects         | Startup rollback, replan or resume |
| Apply interruption           | Snapshot journal, objects, live/recovery | Validate mixed state and resume    |
| Corrupt object               | Digest mismatch                          | Stop inconclusive                  |
| External Git dir or mount    | Scan blocker                             | Resolve or ignore whole boundary   |
| Disk full/fsync failure      | Prior durable state and partial staging  | Stop and preserve evidence         |

## Retention

V3 does not automatically delete objects, event history, conflicts, plans, adoption recovery, apply recovery, old configuration, or old service definitions. `gc --dry-run` reports retained local objects only. Any cleanup needs a separately reviewed retention and backup policy.

## Backup boundary

The CLI requires a backup witness before source seal but does not itself prove the plan's Google Drive archives or Wootbook fixture masters exist. Operational acceptance must verify those external artifacts separately before a daily-driver seal.
