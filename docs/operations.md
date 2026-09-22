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

An authorized local caller can request a targeted post-publication checkout refresh through CodeFolderSync:

```bash
codefoldersync git-refresh --checkout <relative-path> --remote <canonical-url> --branch <default-branch> --commit <published-sha>
```

This command uses the same short-lived writer lock as the daemon's sync pass. It fetches only the named branch and fast-forwards only an exact, contained Git checkout with the expected upstream, a clean worktree, and a published commit in the fetched history. It also skips an incoming path that would overwrite an ignored or otherwise untracked local file. It never stashes, resets, pushes, or creates a merge commit. A dirty, wrong-branch, wrong-repository, ahead, or divergent checkout returns a fixed skip reason. The caller must select an already registered checkout and supply a trusted canonical remote and publication commit; this command does not discover repositories or authorize requests. A stopped daemon is not required for the owner command to run.

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

Before cutover, CTX9 workspace reconciliation remains authoritative for managed repository layout. The current `fleet-i-sync-code-workspaces` controller and target worker inspect the exact Code root before any repository mutation. After a structurally valid V3 projection reaches `normal`, an apply request becomes `codefoldersync-report-only`: it may inspect Git and remote-head drift, but cannot fetch, fast-forward, clone, move, rewrite remotes, adopt catalog paths, or write `.workspace-sync` history. Invalid control state blocks instead of falling back to mutation.

## External acceptance boundary

Repository commands do not authenticate Rclone or decide the Google Drive destination. The fleet controller supplies those protected boundaries and must evidence upload plus `rclone check --download` separately.

`acceptance witness`, backup receipt, restore slot, `acceptance pseudo-fleet`, and `acceptance isolated-fleet` operate only on explicitly named fixture and sentinel roots. They do not discover or default to `~/Code`. Capacity is based on allocated blocks and fails before a fixed machine profile is crossed. `cleanup-run` is the shared exact-path primitive for bulk acceptance cleanup and rejects a missing or mismatched sentinel.

The isolated runner also requires strict SSH between every machine pair and the exact recorded build everywhere. Its capacity preflight runs remotely on all three machines before any repetition. The bounded completion controller uses a generated corpus of at most 25 GiB and removes repetition workspaces after their sanitized witnesses are durable.

The isolated runner installs native service definitions disabled below each repetition root. It activates them only after every target verifies and the acceptance-only cutover projects the normal revision. At the end, or after an interruption, it stops and uninstalls each run-qualified service before exact sentinel cleanup. Only bounded sanitized evidence remains below the Wootbook controller root.
