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

This proves the storage mechanism, not archived-data acceptance. The full runners still use ordinary copying and their conservative copy-capacity gate. Do not bypass that gate or call their output full-view acceptance until they explicitly support, measure, and clean up this storage method. Count physical lower and upper trees, not mounted views; whiteouts represent deleted lower paths and are not regular payload files.

## Object capacity measurement

After building, `node scripts/measure_acceptance_objects.mjs /absolute/codefoldersync-v3-fixtures/snapshot-id/masters` measures the three protected archived Code trees with the production chunker. It applies the default ignore and custody policy, excludes local Git metadata, never follows symlinks, and rejects writable masters or nested mounts. It retains only object hashes and sizes in memory; a fresh sentinel-qualified temporary database remains empty and is removed on exit. Output contains aggregate counts and unique object bytes, never values or paths. Namespace, SQLite, history, recovery, and reserve overhead must still be added. This is a read-only capacity measurement, not registration, synchronization, or an acceptance pass.

## Reflink and database capability

Copy-on-write workspaces alone do not reduce separate raw object databases. Test native extent sharing with:

```bash
sudo -n unshare --mount --fork --propagation private node test/fixtures/reflink-capability.mjs "$(readlink /proc/self/ns/mnt)" "$(id -u)" "$(id -g)"
```

This formats only a newly created sparse 256 MiB image in a fresh temporary sentinel root, then mounts it privately with Btrfs compression. It never formats a block device or existing image. All allocation evidence uses the image's actual blocks after filesystem-local synchronization and trim, not its sparse logical length.

Two mandatory-reflink copies expose complete public fixture workspaces and separate private object databases. Their inodes are distinct, their workspace/state devices match, and database payload extents are initially shared. Unprivileged SQLite and working-file writes leave the protected master and second peer unchanged. A native `FIDEDUPERANGE` probe verifies equal newly materialized bytes before sharing extents; a subsequent private write proves that sharing is copy-on-write. Ordinary directory rename also passes. Cleanup unmounts the run-owned filesystem before deleting its exact temporary image/root.

This is a capability probe, not a full runner or fitting-budget certificate. Any full campaign using this method must explicitly account for the immutable object template, every private database and workload delta, temporary materialization before deduplication, all lower trees, and retained residue. It must distinguish preseeded immutable objects from actual new-object transfer evidence. Shared writable inodes remain forbidden. The small dedupe helper is a fixture primitive, not an unattended real-path walker.

August original backups contain an encrypted archive and a ciphertext witness, without the newer encrypted semantic manifest. Current `restore-master` requires both encrypted artifacts. Historical restoration and its witnesses must remain explicitly identified as historical verification, never presented as a current-format restore result.
