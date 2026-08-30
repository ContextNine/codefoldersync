# CodeFolderSync V3 sync engine

## Recursive scan

The scanner uses `lstat`, locale-stable name ordering, root-relative containment, portable alias checks, and the accepted root ignore compiler. It never follows symlinks or nested mounts. Unsupported object kinds stop the scan.

An exact path retains node identity only when its local device/inode observation still matches; otherwise an unambiguous device/inode match infers a move. This prevents equal-size rename swaps from reusing stale content. After accepted materialization, a trusted checkpoint projection binds cross-machine paths to accepted node IDs. Unchanged observation metadata reuses the accepted manifest during routine scans. `verify --full`, source seal, target planning, approval revalidation, and post-apply verification force content hashing.

`.codefoldersyncignore` is authority metadata rather than an ordinary event. `.codefoldersync` and `.workspace-sync` are hard exclusions. `.git` is diverted into Git-boundary capture.

## Source seal

`adoption seal` requires the authority role, adoption lifecycle, and a non-empty verified backup witness. It force-scans the included source, durably queues the signed checkpoint, transfers missing immutable objects, and accepts it at the fresh hub. A second identical seal is idempotent; a different seal is rejected.

## Adoption plan and apply

Target planning force-scans without modifying the target tree, stores its derived catalog, compares with the source seal, and writes one target-local AES-256-GCM-encrypted plan.

Apply performs:

1. target role and adoption-generation validation;
2. a new force scan matching the approved target digest;
3. source object-closure download and digest verification;
4. top-level target-only/divergent/type-conflict recovery moves;
5. moved-equivalent binding when source placement is absent;
6. journaled canonical directory, leaf, symlink, and Git materialization;
7. independent force scan against source node identity;
8. semantic digest and Git verification;
9. durable baseline and target-verification record.

Any target change after approval causes a new-plan requirement. The authority peer is rejected before planning or apply.

## Normal synchronization

Normal mode compares three snapshots: accepted local baseline, current local scan, and accepted hub checkpoint.

- Local equals hub: update observations and cursor only.
- Local equals baseline: download and apply remote.
- Hub equals baseline: publish local with a sequence CAS.
- Both changed: create a deterministic three-way merge, preserve losing stable content, publish from the current hub sequence, then apply the accepted result.

The hub sequence, not timestamps, determines the canonical side. Checkpoint publication includes whole-namespace metadata plus an explicit deterministic mutation list. Objects remain incremental, and each mutation names its immutable closure. An unchanged directory move therefore publishes a `move-entry` operation while uploading zero objects.

## Apply ordering

Normal apply force-revalidates that the local scan is still current. Moving roots first stage deep to shallow, then occupy destinations shallow to deep so rename cycles cannot overwrite one another. Obsolete top-level subtrees move to unique apply recovery. Desired directories materialize shallow to deep, followed by leaves. Git boundaries stage, `git fsck --full`, swap, and verify. The accepted snapshot and any normal conflicts publish atomically.

Existing bytes are never unlinked as the first destructive action. Cross-filesystem recovery is rejected during setup.

## Daemon

The daemon is available only after cutover. One owner-only lock prevents a second mutating process. macOS uses its native recursive watcher. Linux watches each included physical directory separately so ignored dependencies and reserved control trees never enter the watcher set. A parent event dirties the full scan before a new included directory needs its own watch. A scheduled full scan catches silently dropped native events, so correctness does not depend on watcher ordering. `daemon --reconcile-seconds` can shorten that interval for bounded acceptance runs without changing the signed service default. Services install disabled by default.

## Status

`clean` means the live semantic digest matches the accepted checkpoint and no retained conflict is reported. `conflict` means synchronization completed with retained conflict evidence. `offline` and `inconclusive` are non-success states.
