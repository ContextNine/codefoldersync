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

The external controller creates and formats only a new exclusive-created image, owns namespace/process lifetime, restores the full historical masters, and builds the template. It must stop all children and unmount before outer-root cleanup. The product does not mount, format, elevate privileges, or install a permanent filesystem. This storage support is not a completed original-archive campaign, historical restore controller, native fleet test, or real-folder stress result.
