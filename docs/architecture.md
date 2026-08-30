# CodeFolderSync V3 architecture

CodeFolderSync V3 synchronizes one recursive included namespace through a self-hosted hub. It has no accounts, hosted control plane, or manual repository catalog.

## Control plane

The authority signs monotonically increasing configuration revisions. The signed payload pins folder identity, peer IDs, peer public keys and roles, roots, hub, ignore digest, lifecycle, backup witness, and service policy. A peer projection adds local state paths but must match its signed peer record.

Each peer generates its private identity in its own state directory. Enrollment transfers only a signed public request. The hub verifies peer signatures on published checkpoints and authority signatures on configuration changes. Authority creation, peer enrollment, and accepted-config projection use durable local journals and recognize exact already-accepted hub/config state after an unknown outcome.

The lifecycle begins in `adoption`. Only the authority can seal a checkpoint in that mode. After every required target records a force-verified match, the hub accepts one signed `adoption -> normal` barrier and records it in event history.

## Data plane

The scanner recursively walks the physical root without following symlinks or mounts. It derives stable node IDs from accepted path and local filesystem identity. Regular files use immutable chunks and V3 manifests. Symlinks store exact target text. Directories are catalog nodes, so a stable subtree move changes placement without uploading descendant objects.

Every `.git` occurrence becomes a boundary. Physical directories and contained indirection targets are captured as immutable trees. External indirection stops the scan. Apply stages and verifies the complete Git tree before replacing the live boundary.

## Hub

The hub has a SQLite metadata database and an immutable object database. It stores the accepted signed configuration, current snapshot, global sequence, per-peer sequence, exact mutation/event identities, conflict records, target verification records, and adoption barrier. It derives every submitted mutation list from the accepted base before committing it.

Local mode calls the same store directly. SSH mode starts `codefoldersync hub serve --stdio` and uses the same operation semantics through bounded frames.

## Adoption

The target scan is read-only with respect to the target tree. Its plan classifies exact, source-only, target-only, divergent, moved-equivalent, type-conflicting, and Git-boundary paths. Apply revalidates the target digest, moves losing target evidence to `adoption-recovery/<adoption-id>/`, materializes the source seal, force-hashes the result, verifies Git, and records target verification.

The authority root is rejected as an adoption target in both planning and apply.

## Normal synchronization

Each peer keeps its accepted baseline. A local-only change publishes a signed checkpoint with the exact hub base sequence, a monotonic peer sequence, and explicit node mutations. A remote-only change applies the accepted checkpoint. When both sides changed, the peer performs a three-way merge against its baseline. The already accepted remote state remains canonical and complete losing leaf content becomes a deterministic `CODEFOLDERSYNC-CONFLICT` sibling.

The fleet signs one SSH hub route. The enrolled hub-role peer opens that route's absolute data path locally, while every other peer uses strict SSH. Fleet access intentionally has no self-SSH alias, so the hub role is the only signed local transport exception.

Peer IDs and peer names are fleet-unique. Absolute roots are machine-local and may match across machines, as they normally do on two Macs with the same home and Code layout.

Before network I/O the event and object closure enter the durable outbox. Unknown outcomes retry the exact serialized event. A stale CAS is rebased only after its stable proposal remains represented by the live tree.

## Ownership handoff

When `~/Code/.codefoldersync/config.json` is schema/protocol 3 and lifecycle `normal`, `scripts/workspace-sync.sh` becomes report-only for that root. CodeFolderSync is then the only system allowed to rearrange or update included Code-root content.
