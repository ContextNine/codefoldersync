# CodeFolderSync V3 safety model

## Promise

V3 does not report convergence after silently discarding an observed stable byte sequence, symlink target, Git state, or adopted target object. When it cannot prove containment, identity, durability, configuration authority, or a safe causal result, it stops.

## Filesystem boundary

- The root must be a physical directory.
- State, staging, and recovery live outside the root on the same filesystem.
- All namespace and recovery paths are normalized and contained before use.
- Existing apply ancestors must be real directories.
- Scanner and apply use `lstat`; symlink targets are not traversed.
- Nested mount devices, sockets, FIFOs, devices, unreadable entries, path traversal, overlong components, and portable case/Unicode aliases fail closed.
- `.codefoldersync` and `.workspace-sync` are hard exclusions that negation cannot reinclude.
- `.codefoldersyncignore` is signed authority metadata, not ordinary content.

## Git boundary

Every discovered `.git` is classified. A physical contained directory is supported. A contained indirection or submodule target is supported with dependency-ordered materialization. Malformed, cyclic, missing, linked-worktree, or external Git directories stop the scan.

Git metadata never becomes unrelated leaf events. It is captured as one immutable tree, staged, verified, swapped, and verified again. Codex's persistent zero-byte `.git/codex-repo-sync.lock` is machine-local coordination state and is excluded from that tree. Any other `*.lock` inside Git metadata stops capture because it may identify an active mutation.

## Adoption boundary

The source authority is rejected as an apply target. A target must match its approved scan digest immediately before mutation. Losing target content moves out of root before canonical materialization and receives a durable conflict record. Targets cannot publish ordinary snapshots before the signed barrier.

## Authority and trust

Authority and peer private keys remain in machine-local owner-only state. Config contains public keys and signatures, never private material. The hub pins authority identity at folder creation. Target config tampering cannot advance hub state and makes local validation fail.

SSH provides host transport security. Application signatures additionally limit folder mutations to enrolled peers and configuration changes to the authority.

## Normal conflicts

The first accepted causal state remains canonical. Concurrent losing leaf content becomes a deterministic grep-friendly sibling. Delete conflicts retain explicit evidence. Git conflicts retain their manifest. Timestamps never choose a winner.

## Test and production boundary

Repository integration uses fresh temporary roots and local hubs. Historical sentinel-protected fleet harnesses remain isolated from `~/Code`. No repository test may use the default daily-driver config, active binary, hub, service label, backup fixture master, or real Code folder.

The implementation being green is not authorization to install dependencies, authenticate cloud storage, mutate daily-driver roots, activate services, or delete V2/recovery data.

## Acceptance storage boundary

Acceptance storage uses fixed physical-allocation profiles: 5 GiB transient per Mac, 25 GiB for the generated non-secret corpus, a 150 GiB normal Wootbook target, and a 200 GiB Wootbook hard limit. Sparse logical length never substitutes for allocated-byte measurement, and hard-linked inodes are counted once.

Bulk cleanup requires an absolute run-qualified root with its exact sentinel. It never follows a symlink, crosses to a daily-driver root, or targets Drive backups, adoption recovery, V2 evidence, credentials, configuration, or active product state. Cleanup failure is a failed gate rather than permission to broaden the deletion.
