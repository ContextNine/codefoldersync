# Full-view acceptance storage

Bulk acceptance runs belong on Wootbook. Count all retained ciphertext, restored lower trees, peer upper/work directories, hub objects, history, and recovery against the 150 GiB target and 200 GiB hard limit. Free disk capacity does not increase this limit. Macs have a 5 GiB incremental transient limit.

An overlay peer must expose every original path and byte. Its writable upper directory is private to that peer. The restored lower tree stays protected and unchanged. Never use shared writable hard links, a reduced corpus, or a live Code directory as a substitute. Workspace allocation includes local Git metadata and excluded ENV files. Object-store estimates count only policy-included files and symlink text, without reading their values; Git metadata and custody-excluded ENV files do not become sync objects.

The peer's synchronized Code directory and private state/recovery must be children of the same overlay root. The product rejects cross-device recovery. Mount each peer only inside a private mount namespace, never in the host namespace. Stop all run children and unmount all views before sentinel-qualified cleanup.

## Capability probe

On a Linux worker with password-free namespace access, run from this repository:

```bash
sudo -n unshare --mount --fork --propagation private node test/fixtures/overlay-capability.mjs "$(readlink /proc/self/ns/mnt)" "$(id -u)" "$(id -g)"
```

The probe refuses root as the peer identity and an unchanged mount namespace. It creates only a small fresh temporary fixture with its own sentinel. A tar stream builds a complete compressed SquashFS lower image without writing a plaintext tar file. The image mounts read-only on a run-owned automatically cleared loop device. Two overlay views use `metacopy=on`. The probe verifies complete fixture content and symlinks, zero payload blocks after writable metadata copy-up, unprivileged state and file writes, same-device workspace/state, isolated edits and deletion, and unchanged lower bytes, allocation, and permissions. It unmounts both views and the image and removes only its exact fixture root before returning.

This proves the overlay storage mechanism, not archived-data acceptance. The runners do not support overlay inputs. Count physical lower and upper trees, not mounted views; whiteouts represent deleted lower paths and are not regular payload files. The pseudo-fleet runner supports the separately validated bounded Btrfs method below. The native isolated runner still uses its ordinary-copy capacity gate.

## Object capacity measurement

After building, `node scripts/measure_acceptance_objects.mjs /absolute/codefoldersync-v3-fixtures/snapshot-id/masters` measures the three protected archived Code trees with the production chunker. It applies the default ignore and custody policy, excludes local Git metadata, never follows symlinks, and rejects writable masters or nested mounts. It retains only object hashes and sizes in memory; a fresh sentinel-qualified temporary database remains empty and is removed on exit. Output contains aggregate counts and unique object bytes, never values or paths. Namespace, SQLite, history, recovery, and reserve overhead must still be added. This is a read-only capacity measurement, not registration, synchronization, or an acceptance pass.

## Reflink and database capability

Copy-on-write workspaces alone do not reduce separate raw object databases. Test native extent sharing with:

```bash
sudo -n unshare --mount --fork --propagation private node test/fixtures/reflink-capability.mjs "$(readlink /proc/self/ns/mnt)" "$(id -u)" "$(id -g)"
```

This formats only a newly created sparse 256 MiB image in a fresh temporary sentinel root, then mounts it privately with Btrfs compression. It never formats a block device or existing image. All allocation evidence uses the image's actual blocks after filesystem-local synchronization and trim, not its sparse logical length.

Two mandatory-reflink copies expose complete public fixture workspaces and separate private object databases. Their inodes are distinct, their workspace/state devices match, and database payload extents are initially shared. Unprivileged SQLite and working-file writes leave the protected master and second peer unchanged. A native `FIDEDUPERANGE` probe verifies equal newly materialized bytes before sharing extents; a subsequent private write proves that sharing is copy-on-write. Ordinary directory rename also passes. The fixture also exercises the actual pseudo-fleet runner through two fresh repetitions as an unprivileged peer, with preseeded immutable objects, matching target digests, unchanged master witnesses, and cleanup between repetitions. Cleanup unmounts the run-owned filesystem before deleting its exact temporary image/root.

This is a capability probe, not a full runner or fitting-budget certificate. Any full campaign using this method must explicitly account for the immutable object template, every private database and workload delta, temporary materialization before deduplication, all lower trees, and retained residue. It must distinguish preseeded immutable objects from actual new-object transfer evidence. Shared writable inodes remain forbidden. The small dedupe helper is a fixture primitive, not an unattended real-path walker.

August original backups contain an encrypted archive and a ciphertext witness, without the newer encrypted semantic manifest. Current `restore-master` requires both encrypted artifacts. Historical restoration and its witnesses must remain explicitly identified as historical verification, never presented as a current-format restore result.

## Bounded pseudo-fleet runner

An optional `storage` entry in the pseudo-fleet specification selects `bounded-reflink`. `src/v3/acceptance-reflink.ts` validates a sentinel-qualified outer volume run, a private mount namespace distinct from the inherited namespace, an exact Btrfs loop mount, and its matching regular backing file. The backing image has one link, private permissions, and a fixed size exactly equal to `maximumImageBytes`. Every master, run workspace, state directory, hub database, recovery file, and immutable object template stays within this one filesystem. Mandatory reflinks fail rather than falling back to ordinary copies.

Inventory every retained acceptance root outside the volume in `retainedRoots`. These physical roots must not overlap each other or the outer volume run. The budget adds their current physical allocation, the image's **maximum size**, and a 64 MiB reserve for the outer sentinel, private control files, and bounded external evidence. That total must not exceed 200 GiB. The result separately reports whether the total exceeds the normal 150 GiB target. This replaces the ordinary-copy estimate only for a volume whose fixed backing size bounds even temporary writes. It does not assert that the complete data will fit: filesystem exhaustion must fail acceptance, not truncate input or discard recovery. Do not resize the image during a run or write bulk acceptance data outside it. The controller must account for outside residue growth and keep external control/evidence within its reserve.

`seedAcceptanceObjectTemplate` captures every policy-included leaf from protected, same-filesystem masters with the production chunker. It never follows symlinks or captures Git metadata. It copies reused chunk buffers and flushes at 8 MiB or 4,096 objects, avoiding one corpus-sized SQLite transaction. A single chunk can cross that buffer threshold by up to the production chunk limit. Closing the database checkpoints it before protection. The template contains only content objects, never identity, configuration, catalog, history, or keys.

Each repetition clones the closed, protected `objects.sqlite` with `--reflink=always` into distinct writable peer and hub inodes. Product reads still verify SHA-256 integrity. Existing objects are explicitly **preseeded** in the result; only subsequent workload objects exercise new-object transfer. Repetitions run sequentially and remove their exact sentinel-qualified peer/hub roots after retaining bounded results. The final whole-master witnesses must still match. No product garbage collection is enabled.

Each peer also hashes its complete local Git metadata, ignored trees, reserved
`.workspace-sync` state, and custody-excluded leaves before setup and after all
faults and no-change verification. The witnesses include paths internally,
types, modes, sizes, symlink text, and exact file hashes, but expose only aggregate
counts and one digest per peer. They must match that same peer's initial witness,
not another machine's state. Traversal never follows symlinks or crosses mounts.
Only the root `.codefoldersync` and `.codefoldersyncignore` projections are
omitted because this fresh setup owns them. Nested historical metadata is still
witnessed. This proves byte and
mode preservation, not Git object validity or paused-checkout eligibility.

The external controller creates and formats only a new exclusive-created image, owns namespace/process lifetime, restores the full historical masters, and builds the template. It must stop all children and unmount before outer-root cleanup. The product does not mount, format, elevate privileges, or install a permanent filesystem. This storage support is not a completed original-archive campaign, native fleet test, or real-folder stress result.

## Full-tree fault stages

`src/v3/acceptance-faults.ts` runs inside each fresh pseudo-fleet repetition after
initial adoption and workload convergence. It keeps every adopted path available;
its generated probes are mutations within that complete corpus, not replacement
input trees. All probe operations contribute to a deterministic scenario digest.

The packaged product processes are killed with `SIGKILL` after durable outbox
creation, hub acceptance before acknowledgement, and move staging. A private
phase marker and the actual child termination signal prove the boundary. Restart
must drain queued work, retry an already accepted event without a new sequence,
and finish the journaled subtree move. The move must upload zero objects.

Concurrent writes must retain the first accepted bytes and the exact losing bytes
in a visible conflict sibling on every peer. The losing peer also recovers the
immutable conflict privately through its packaged agent. The outage stage moves
only the run-owned hub aside and temporarily puts an exact marker at its configured
path. Sync and verification must reject that unavailable hub without losing the
offline edit. The exact marker is removed and the held hub restored before retry.

The corruption stage damages only the newly generated canary's known chunk in
the disposable hub database. A target that lacks that chunk must reject apply,
and its force verifier must reject the missing canary. The runner repairs that
exact probe chunk before requiring complete convergence. Final force verification
and the no-change pass still cover every peer's entire included namespace.

Crash and recovery agent actions require an exact disposable-run sentinel and
physical contained peer roots. Recovery destinations stay below private peer
state with checked ancestors. Results contain only counts, pass flags, crash
phases, and the scenario digest, never probe contents or real archived paths.
When `nativeFaultLibrary` names a protected Linux ELF artifact and its exact
SHA-256, the runner also injects `ENOSPC` writes and `EIO` fsync calls through
the native staging-only preload shim. Each failure must stop apply with that
syscall error and retain the preceding probe bytes under the journal's private
recovery root. Clean retry must converge every peer while keeping that recovery
copy. The library is revalidated before each injection, and only run-local peers
with a matching sentinel may load it. Results list the executed native faults;
an empty list explicitly means this lane was not run.

These stages do not substitute for sustained churn, Git-state, AI/replay, and
machine-platform gates, or prove that any full original corpus has run yet.

## Historical full-archive controller

The controller requires `nativeFaultLibrary` with a physical protected library
path and its exact SHA-256 before creating a volume. Build the small staging
fault shim from `test/fixtures/filesystem-fault.c`, record its source and artifact
hashes, remove its write bits, and account for the retained artifact with the
other control data. The real controller cannot silently omit native write/fsync
failure coverage. This is a test artifact, not a daily-driver preload setting.

After building and verifying the candidate, run the external controller inside a fresh private mount namespace:

```bash
sudo -n unshare --mount --fork --propagation private node scripts/run_bounded_archived_acceptance.mjs controller /private/controller-spec.json
```

The private specification declares schema 1, a run ID, original snapshot ID, seed, unprivileged UID/GID, inherited mount namespace, protected identity path, accepted candidate archive/hash, existing physical run parent, fresh external evidence directory, all retained acceptance roots, and an allocation limit no greater than 200 GiB. `corpus` is `original-code-archive` for the actual campaign; public fixture runs explicitly use `public-fixture` and report `acceptanceCorpus: false`. Write destinations and retained roots may not be inside a live Code directory. Canonical executable paths must resolve without symlinks. This is not a general fleet provisioner.

Each of the three source records declares its exact archive name, ciphertext bytes/SHA-256, complete historical protected `TreeWitness`, and already proved recovery/downloaded-content gates. The specification references witnesses, never plaintext credentials or ENV values. Those gate booleans are controller inputs, not independent certification of prior Drive acceptance; the operator must retain actual managed verification evidence separately.

Use the maintained Rclone controller as `downloadCommand`, for example an absolute Python executable and the installed or maintained `rclone_google_drive.py` path. The runner adds `download --machine-id wootbook --source-machine-id … --snapshot-id … --destination … --approve`. It never enumerates another hierarchy or copies credentials. The downloader must return its verified JSON receipt only after all transfer children have exited.

Downloads occupy fresh sentinel-qualified slots outside the private mounted filesystem. This allows a credential broker in another mount namespace to reach the same destination. Only one slot exists at a time. The image initially reserves the largest source ciphertext size plus 64 MiB slot overhead **outside** its own maximum size, in addition to retained allocation and the normal 64 MiB control reserve. Check actual slot allocation against that declared bound. Once a download returns, independently compare its exact flat witness, archive size, and full ciphertext SHA-256. Stream age, zstd, and native tar into the private volume without writing a plaintext tar file. Permit only the documented BSD metadata-key warnings, protect the complete restored Code tree, and compare every historical witness field. Reject incomplete streams, unexpected entries, unsafe physical roots, unsupported objects, nested mounts, or tree divergence.

Remove only that new downloaded slot after its processes exit. The original ciphertext and identity are never copied into a cleanup target. After all three slots are gone, grow only the run-owned image and its matching loop capacity, before building the template or starting any product repetition. The final fixed image size plus freshly inventoried retained roots and control reserve must pass the product budget. No resize occurs during product execution. Insufficient compression or filesystem space fails the full campaign; no path or byte is omitted to make it fit.

The controller hashes the candidate archive before extraction and installation into the private volume. It imports the runner and object-template builder from that exact extracted candidate and verifies its installed CLI release identity through distributed setup. Full protected witnesses precede and follow both fresh repetitions. Bounded controller evidence contains historical counts/digests, candidate hash, template counts, repetition summaries, maximum allocation, actual synchronized/trimmed image allocation, and exact removed allocation. The full private trees and image are unmounted and removed after child commands finish, on success or failure. Failure output contains only a phase and source-code line, never diagnostics or values. Interrupts notify the unprivileged worker but drain its current managed transfer before cleanup, so a broker-owned child cannot keep writing into a deleted slot.

The existing native storage fixture exercises this controller with three complete public encrypted trees, including a downloader deliberately placed in the host namespace. It proves historical comparison, sequential slot cleanup, pre-run resize, exact-candidate installation, two fresh convergent repetitions, and final volume removal. A second invocation corrupts only a new downloaded ciphertext and proves rejection/cleanup while the original fixture archives retain their hashes. Initial fixture failures caught a noncanonical executable path before the workflow started. These checks do not prove that the real original archives fit, that Drive recovery completed, or that the remaining full-data fault, native, stress, release, and pilot gates passed.
