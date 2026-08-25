# CodeFolderSync V3 operations

## Adoption status

```bash
codefoldersync config status --config <path>
codefoldersync catalog status --config <path>
codefoldersync status --config <path>
codefoldersync conflicts --config <path>
```

Status reports lifecycle, config revision, hub sequence, derived catalog size, accepted catalog-history count, retained tombstones, Git-boundary count, retained conflicts, and verified adoption peers. Catalog status is observation-only; V3 has no membership mutation command.

If the hub is unavailable or rejects the local projection, status still returns local lifecycle, authority, revision, cursor, outbox, journal, catalog, tombstone, recovery, and conflict evidence with `hubReachable: false`, a null hub sequence, and the connection error. It does not describe an offline peer as clean.

## Source and targets

The authority runs `adoption seal` only after external backup gates pass. A target runs `adoption plan`, reviews the returned counts and recovery consequences, then applies the exact adoption ID. Any target change makes that plan stale.

`adoption verify` is a full content and Git check. Cutover requires every non-hub target to have recorded the current source sequence and digest and requires `--approve`.

## Normal operation

```bash
codefoldersync sync
codefoldersync verify --full
codefoldersync doctor
codefoldersync service status
codefoldersync service logs
```

`verify --full` rehashes all included files and Git boundaries. `offline` and `inconclusive` are failures. `conflict` means synchronization completed while retained explicit conflict evidence remains.

## Ignore changes

There is no target-side push/pull command. Preserve the prior accepted ignore file, change `.codefoldersyncignore` only on the authority, and preview the exact included/excluded entry and byte counts:

```bash
codefoldersync config update-ignore --previous-ignore /path/to/previous.ignore
codefoldersync config update-ignore --previous-ignore /path/to/previous.ignore --approve
```

Approval signs and accepts one compare-and-swap configuration revision. Project the accepted config and exact ignore file to every peer before synchronization resumes. Reserved control roots can never be included.

## Conflict response

1. Stop writers for affected paths.
2. Inspect `conflicts` and `history` without deleting evidence.
3. Copy retained adoption evidence with `recover` when needed.
4. Resolve visible normal siblings with ordinary tools.
5. Run `verify --full` and Git checks before resuming.

## Incident response

On corruption, disk failure, unsafe path, external Git dir, apply journal, or unexplained divergence:

1. stop the peer service and Code-root writers;
2. preserve live root, state, hub, outbox, plans, staging, and recovery;
3. capture `doctor`, `status`, free space, and read-only Git diagnostics;
4. restore connectivity or capacity;
5. let startup recover prepared journals;
6. rerun sync and full verification.

Do not clear an incident by deleting objects, journals, or recovery.

## Workspace ownership

Before cutover, CTX9 workspace reconciliation remains authoritative for managed repository layout. After the accepted V3 config at `~/Code/.codefoldersync/config.json` reaches `normal`, `scripts/workspace-sync.sh` reports only and cannot clone or fast-forward beneath that root.

## External acceptance boundary

Repository commands do not authenticate Rclone, create Google Drive backups, create Wootbook masters, or authorize daily-driver adoption. Those steps belong to the gated fleet plan and must be evidenced separately.
