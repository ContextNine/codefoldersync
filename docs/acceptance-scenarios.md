# CodeFolderSync V3 acceptance scenarios

## Focused repository integration

`test/product.integration.test.ts` runs seven grouped end-to-end tests in fresh temporary roots. Related cases and fault matrices execute inside those subsystem groups so the product suite stays focused.

### Populated source and two populated targets

The fixture contains direct files, deep directories, executable content, a broken symlink, an ordinary non-Git directory, a nested Git repository, ignored `node_modules`, and reserved `.workspace-sync` state.

Both targets contain exact content, divergent content, target-only content, moved-equivalent content, and divergent Git state. Acceptance requires:

- source force-verifies before and after with the same hub sequence;
- target plans expose target-only, divergent, and moved-equivalent classifications;
- every displaced top-level target value has a live recovery object and conflict record;
- moved-equivalent bytes bind to the source path;
- reserved and ignored target state remains machine-local;
- nested Git HEAD and `git fsck --full` match the source;
- both targets independently force-verify clean.

### Signed cutover and normal multi-writer synchronization

Cutover is attempted only after both target verifications. The latest normal revision is projected to each target. Acceptance then covers:

- authority edit propagation to both targets;
- concurrent same-file writes with canonical original plus exact keep-both sibling;
- deep directory rename convergence with zero uploaded objects;
- file and directory rename swaps, case-only rename, and Unicode-normalization rename;
- ignored dependency churn producing no publication;
- matching normal lifecycle revisions on every peer.

### Failure controls

The suite proves:

- cutover before target verification is rejected;
- a target-edited lifecycle fails authority signature validation;
- a target-edited ignore projection fails the accepted digest contract;
- a contained worktree pointing to an external Git directory blocks source seal.
- source seal, adoption, normal apply, and cutover resume at every injected durable phase;
- an unrelated edit during interrupted apply remains live and blocks resume;
- directory conflict recovery works from its immutable subtree manifest;
- contained Git indirection transfers and passes `git fsck --full`;
- a persistent Codex repository-coordination lock is excluded while an ordinary Git lock still fails closed;
- corrupt hub objects fail before target mutation;
- case/Unicode aliases, FIFOs, and sockets fail closed.

## Workspace ownership scenario

The public fleet package test `fleet-i-sync-code-workspaces/scripts/test_workspace_reconciliation.py` creates fresh temporary Code roots and managed Git fixtures. It proves that a structurally valid V3 `normal` projection reduces target and controller apply requests to read-only reports, reports remote drift without fast-forwarding, skips history, agent-configuration, plugin, catalog, and remote mutations, and blocks malformed control state. Lifecycle `adoption` and an absent control directory retain ordinary workspace ownership.

## Historical harnesses

The repository retains older sentinel-protected safety and churn harnesses. They remain useful for general loss detection, process supervision, and service confinement, but their V2 product workflow is not V3 fleet acceptance.

## Reproducible V3 fleet runners

`test/distributed.integration.test.ts` proves the executable foundations for external acceptance:

- distributed setup runs through process-isolated product commands and requires the same recorded release SHA-256 everywhere;
- preparation stops before target mutation and each target apply requires its exact adoption ID;
- every remote mutation boundary resumes after the operation completed but its response was lost;
- `test/real-ssh-response-loss.ts` drives a strict canonical SSH route through a sentinel-qualified remote wrapper that closes the first completed setup response, then requires exact identity reuse, clean seal, and clean verification;
- pseudo-fleet acceptance creates two fresh fleets with new roots, identities, hubs, and controller state;
- both repetitions copy the same witnessed masters, apply the same deterministic 64-file cassette, and require exact final semantic digests;
- the AI workload requires at least 50 changed TypeScript files across eight directories, verifies required create, move, and delete behavior, records a private cassette, and replays it to the same final digest;
- the Linux durability lane injects real `ENOSPC` write and `EIO` fsync results below materialization staging, requires an inconclusive result with retained prior bytes, then retries to clean full verification;
- the Linux watcher lane freezes the daemon, proves `IN_Q_OVERFLOW` with a separate native watcher, writes the included marker after saturation, and requires the scheduled full scan to publish it;
- the Linux mount lane runs the installed product in a networkless, read-only container with a real nested tmpfs and requires source seal to stop before hub publication;
- the large-snapshot lane scans 4,096 TypeScript files and proves a no-change pass uploads zero objects;
- an unreadable Linux subtree stops source seal before the hub accepts a sequence;
- isolated preparation verifies each master before and after its copy, requires a fresh remote repetition root, and creates the generated AI fixture only on the source so both populated targets receive it through adoption;
- the isolated controller invokes the hub machine locally, verifies strict SSH over every directed pair of distinct machines, runs the normal product setup and per-target approvals, signs cutover only inside the acceptance command, and projects the normal revision to every peer;
- native launchd and systemd definitions install disabled in run-qualified directories, then start, restart, stop, and uninstall under a fresh folder ID;
- the Linux systemd lane edits while stopped and requires the next start's full reconciliation to publish the missed change;
- long-lived source, hub, and target observers stream hashed state changes to one controller. Only that controller assigns accepted timing.

The pseudo-fleet command accepts only an existing run root with a matching sentinel. It refuses an existing repetition directory, writes one sanitized result outside the disposable root, and removes that exact root after success or failure. It never cleans a prior run or a master:

```bash
codefoldersync acceptance witness --root /absolute/master/Code
codefoldersync acceptance storage-inventory --root /absolute/run-root
codefoldersync acceptance storage-budget --root /absolute/run-root --profile mac-transient --baseline-allocated-bytes 0 --projected-additional-bytes 0
codefoldersync acceptance capture-backup --spec /private/capture.json --approve
codefoldersync acceptance capture-backup-stream --spec /private/capture-stream.json --approve
codefoldersync acceptance receive-backup-artifact --spec /private/receipt.json --artifact archive --approve
codefoldersync acceptance receive-backup-witness --spec /private/receipt.json --approve
codefoldersync acceptance finalize-backup-receipt --spec /private/receipt.json --approve
codefoldersync acceptance generate-bounded-corpus --spec /private/corpus.json --approve
codefoldersync acceptance restore-master --spec /private/restore.json --approve
codefoldersync acceptance verify-restore-slot --spec /private/restore-slot.json --approve
codefoldersync acceptance cleanup-run --spec /private/cleanup.json --approve
codefoldersync acceptance pseudo-fleet-capacity --spec /private/pseudo-fleet.json
codefoldersync acceptance pseudo-fleet --spec /private/pseudo-fleet.json --approve
codefoldersync acceptance isolated-fleet-capacity --spec /private/isolated-fleet.json
codefoldersync acceptance isolated-fleet --spec /private/isolated-fleet.json --approve
```

Witness and committed result output contains aggregate counts, bytes, digests, timing, and pass state. Master paths and cassette contents remain in private run state.

`capture-backup` requires a fresh sentinel-qualified staging root, a physical source root named `Code`, a source platform matching the current machine, a fresh bundle destination, and exactly two distinct age recipients. It writes a deterministic NUL member list and an NDJSON semantic manifest in an owner-only staging directory, inventories the source before and after the archive stream, and rejects a changed path, nested mount, unsupported object, read failure, symlinked or external Git directory, Unicode-normalized path alias, child-process warning, or digest mismatch. The archive streams directly through tar, zstd, and age without a plaintext archive file. The portable manifest records every path kind, file digest, executable meaning, symlink target and target digest, archive member, and contained Git semantic state. A canonical digest over tar headers and PAX records separately verifies modes, hard links, sparse metadata, ACLs, xattrs, flags, and resource forks. It excludes only access/change time, archive creation time, and macOS `com.apple.provenance`, which extraction necessarily changes or creates. Native macOS capture explicitly uses libarchive ACL, xattr, and file-flag records with AppleDouble synthesis disabled. The accepted flat bundle contains only the encrypted archive, encrypted compressed manifest, and their value-free ciphertext witness.

`capture-backup-stream` keeps only bounded inventory files on the source. It sends the age ciphertext directly to separately invoked receipt commands, hashes the bytes again before they leave the source process, and requires the receiver to return the same byte count and SHA-256. Wootbook receives one archive and manifest at a time below a sentinel-qualified root, enforces its allocation budget during the stream, compares its independent receipts with the source witness, and atomically finalizes the same flat three-file bundle. A source change or failed child command invokes the exact abort command and removes source staging in a guaranteed cleanup phase.

Physical inventory counts allocated blocks, sparse logical size, and hard-linked inodes without following symlinks or crossing a mount. The fixed profiles are 5 GiB for Mac transient data, 25 GiB for a generated corpus, a 150 GiB normal Wootbook target, and a 200 GiB Wootbook hard limit. `cleanup-run` removes only an absolute run-qualified directory with the exact sentinel. It makes protected contents owner-writable and clears platform protection only inside that root.

`generate-bounded-corpus` turns sanitized aggregate counts into a deterministic, non-secret `Code` tree. Its versioned shape controls directory count, depth, file count and bytes, executability, symlinks, and contained Git repositories. Generation checks physical allocation throughout and cannot request or retain more than 25 GiB.

The capacity commands are read-only preflights over the exact specification and sentinel roots. They project both workspace copies, one content-addressed object store per peer plus the hub, target recovery, and a final 25 percent reserve from the accepted ignore contract. The isolated command measures the protected master and available bytes on each real machine through the pinned binary, then enforces the machine's declared 5 GiB Mac or 150 GiB Wootbook profile. Both mutating runners repeat their capacity gate before they copy a master.

`restore-master` accepts one flat ciphertext bundle, its source witness, declared source platform, and an age identity path from a private spec. It recomputes both ciphertext SHA-256 values, decrypts the semantic manifest without printing it, streams the archive through age, zstd, and native tar, and regenerates the complete portable oracle from the restored tree. On a matching platform it also recreates the canonical tar metadata digest and requires exact equality before protection and atomic placement. A Linux restore of a declared macOS archive skips that platform-only comparison and explicitly counts and ignores only BSD tar's `LIBARCHIVE.creationtime`, `LIBARCHIVE.xattr.*`, `SCHILY.acl.*`, and `SCHILY.fflags` records; every portable byte, executable, symlink, archive-member, and Git semantic record must still match. The command never contacts Drive, so source-local success does not satisfy the separate Drive-download gate.

`verify-restore-slot` adds Wootbook's one-slot policy. The downloaded bundle and destination must both be inside the sentinel-qualified slot, while the age identity must remain outside it. The command checks the projected 150/200 GiB budget, runs the complete restore verification, checks allocation again, returns bounded evidence, and deletes the whole slot on both success and failure.

The live AI acceptance scenario uses an explicit model command in a generated non-secret TypeScript repository inside the run root. The runner sends a versioned prompt on standard input, observes mutations with one monotonic controller clock, validates the final repository, and stores file paths and content only in the private cassette. Hub acceptance is recognized by reconstructing the accepted workspace content oracle from immutable hub chunks, not a pre-publication namespace digest whose new node identities have not been allocated yet. Cross-platform visibility compares bytes and executability while the private cassette retains the source mode for exact replay. Target observers retain their last stable observation across the brief missing-path window of an atomic snapshot replacement. The result records model duration, first source change, final hub acceptance, per-target convergence, and path visibility p50, p95, and maximum. The second fresh repetition replays the first repetition's private cassette without invoking the model and requires the same final digest.

Successful and failed isolated runs stop and uninstall every run-qualified native service. The controller allows a bounded ten-second native-manager shutdown window before it fails with the exact machine ID. The final bounded controller must retain only sanitized evidence and invoke exact sentinel cleanup for the bulk workspace after either outcome.

The isolated specification names exactly three machines, stable SSH aliases, absolute run-qualified product commands, witnessed read-only masters, per-machine run roots, machine storage profiles, one bounded evidence directory directly below the Wootbook controller root, one hub target, and the AI command. The controller invokes that one hub endpoint locally because the fleet intentionally does not render self-SSH routes. Each machine agent still verifies both other machines through strict canonical SSH, so all six meaningful directions must pass. Every base root must already contain an exact run sentinel. The controller refuses any other local endpoint, overlapping master and run roots, an existing unprepared repetition, a changed master, a mismatched product build, or an AI prompt other than the accepted prompt. It retains only sanitized success or failure evidence after all exact repetition roots are removed. Service uninstall moves definitions into run-local recovery before that run-local recovery is deleted with its repetition root.

## Required external V3 acceptance

Before daily-driver use, the plan still requires:

1. verified encrypted backups of all three current Code roots;
2. Wootbook immutable fixture masters and a restore drill;
3. two executions of the full three-snapshot V3 pseudo-fleet lane with the remaining real fault matrix;
4. execution of the isolated runner on all three real machines, including its two fresh repetitions;
5. a fresh daily-driver preview and explicit target-by-target apply approval;
6. canary, restart, offline-edit, move, and conflict observation after cutover.

None of those are implied by the focused repository suite.
