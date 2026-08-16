# CodeFolderSync local validation, 2026-08-16

## Outcome

The native CodeFolderSync engine and three-peer live adapter pass locally without an external service.

The implementation uses local peer IDs, an operator-chosen local or SSH hub, immutable whole-repository snapshots, per-repository compare-and-swap heads, durable recovery snapshots, and explicit divergence resolution.

## Proven behavior

- serial alpha → beta → gamma handoff preserves exact files, executable modes, Git refs, index state, uncommitted work, and untracked files;
- simultaneous alpha/atlas and beta/birch publication converges without global folder serialization;
- simultaneous edits to one repository preserve every complete repository state, leave blocked workspaces untouched, and require explicit resolution;
- recovered divergent snapshots pass digest validation and `git fsck --full` before resolution;
- both `--take remote` and `--take local` retain the unselected state in immutable history;
- 40-operation workers on three independent repositories converge after create, rename, chmod, stage, unstage, append, replace, delete, commit, and branch/ref changes;
- repeated fresh CLI processes converge, proving process-local cache is not the source of agreement;
- Git observation uses `--no-optional-locks`, preventing the verifier itself from changing the synchronized index;
- an altered immutable snapshot is rejected;
- deliberate completed-operation loss is rejected on every peer;
- a surviving Git object without its required ref meaning is rejected;
- heartbeat expiry terminates a delayed writer before mutation;
- unsafe run roots and cleanup targets are rejected.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm codefoldersync --help
```

The native live integration test creates three isolated clients and runs serial, raw conflict, and guarded churn scenarios through the actual product CLI. Temporary roots are removed only after assertions complete.

## Fleet acceptance

Alpha and beta ran as isolated clients on Wootbook. Gamma and each run-scoped hub ran on Worker Mac Air over WireGuard SSH. Worker Mac Air reported a case-insensitive filesystem; Wootbook reported case-sensitive filesystems. All peers reported the same UTF-8 bytes for the Unicode filename probe.

| Scenario                   | Run                                  | Required/recovered | Filesystem digest | Git semantic digest | Verdict |
| -------------------------- | ------------------------------------ | -----------------: | ----------------- | ------------------- | ------- |
| delayed serial handoff     | `native-fleet-serial-20260816-003`   |     27/27 per peer | `0ebf8992…30bce`  | `aa3d74ac…ed57`     | pass    |
| same-repository divergence | `native-fleet-conflict-20260816-001` |       6/6 per peer | `17b66915…41b7b`  | `1bfc4273…18922`    | pass    |
| parallel guarded churn     | `native-fleet-churn-20260816-001`    |   126/126 per peer | `f7466ea9…cd861`  | `39b7be90…9c45d`    | pass    |

The conflict run recovered and Git-validated all three divergent `atlas` repositories before resolution. Gamma selected remote, beta selected local, both unselected states remained in immutable history, and the final clients converged.

Evidence:

- [serial result](native-fleet-serial-20260816-003/result.json) and [report](native-fleet-serial-20260816-003/report.md)
- [conflict result](native-fleet-conflict-20260816-001/result.json) and [report](native-fleet-conflict-20260816-001/report.md)
- [churn result](native-fleet-churn-20260816-001/result.json) and [report](native-fleet-churn-20260816-001/report.md)

All three close checks reported clean clients. Test workspaces, immutable hub history, conflict snapshots, and recovery directories were preserved for diagnosis.
