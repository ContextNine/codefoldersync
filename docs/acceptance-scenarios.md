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

## Required external V3 acceptance

Before daily-driver use, the plan still requires:

1. verified encrypted backups of all three current Code roots;
2. Wootbook immutable fixture masters and a restore drill;
3. a full three-snapshot V3 pseudo-fleet lane with failure injection;
4. two isolated real-machine runs on fresh sentinel roots;
5. a fresh daily-driver preview and explicit target-by-target apply approval;
6. canary, restart, offline-edit, move, and conflict observation after cutover.

None of those are implied by the focused repository suite.
