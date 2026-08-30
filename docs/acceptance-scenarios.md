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
- corrupt hub objects fail before target mutation;
- case/Unicode aliases, FIFOs, and sockets fail closed.

## Workspace ownership scenario

`scripts/test-workspace-sync.sh` creates a managed Git fixture, advances its remote, then installs a structurally valid V3 normal marker at the Code root. An `--apply` run must report drift without fast-forwarding. Removing the test marker restores normal workspace apply. All paths live below one validated temporary root.

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
- isolated preparation verifies each master before and after its copy, requires a fresh remote repetition root, and creates the generated AI fixture before adoption;
- the isolated controller verifies every directed SSH pair, runs the normal product setup and per-target approvals, signs cutover only inside the acceptance command, and projects the normal revision to every peer;
- native launchd and systemd definitions install disabled in run-qualified directories, then start, restart, stop, and uninstall under a fresh folder ID;
- the Linux systemd lane edits while stopped and requires the next start's full reconciliation to publish the missed change;
- long-lived source, hub, and target observers stream hashed state changes to one controller. Only that controller assigns accepted timing.

The pseudo-fleet command accepts only an existing run root with a matching sentinel. It refuses an existing repetition directory and never cleans a prior run or a master:

```bash
codefoldersync acceptance witness --root /absolute/master/Code
codefoldersync acceptance pseudo-fleet --spec /private/pseudo-fleet.json --approve
codefoldersync acceptance isolated-fleet --spec /private/isolated-fleet.json --approve
```

Witness and committed result output contains aggregate counts, bytes, digests, timing, and pass state. Master paths and cassette contents remain in private run state.

The live AI acceptance scenario uses an explicit model command in a generated non-secret TypeScript repository inside the run root. The runner sends a versioned prompt on standard input, observes mutations with one monotonic controller clock, validates the final repository, and stores file paths and content only in the private cassette. It records model duration, first source change, final hub acceptance, per-target convergence, and path visibility p50, p95, and maximum. The second fresh repetition replays the first repetition's private cassette without invoking the model and requires the same final digest.

The isolated specification names exactly three machines, stable SSH aliases, absolute run-qualified product commands, witnessed read-only masters, per-machine run roots, one hub target, and the AI command. Every base root must already contain an exact run sentinel. The controller refuses local endpoints, overlapping master and run roots, an existing unprepared repetition, a changed master, a mismatched product build, or an AI prompt other than the accepted prompt. It preserves test roots and private evidence. Service uninstall moves definitions into run-local recovery instead of deleting them.

## Required external V3 acceptance

Before daily-driver use, the plan still requires:

1. verified encrypted backups of all three current Code roots;
2. Wootbook immutable fixture masters and a restore drill;
3. two executions of the full three-snapshot V3 pseudo-fleet lane with the remaining real fault matrix;
4. execution of the isolated runner on all three real machines, including its two fresh repetitions;
5. a fresh daily-driver preview and explicit target-by-target apply approval;
6. canary, restart, offline-edit, move, and conflict observation after cutover.

None of those are implied by the focused repository suite.
