# CodeFolderSync V3 development and verification

## Repository boundaries

The CTX9 workspace and nested CodeFolderSync product are independent repositories. Read both `AGENTS.md` files, preserve unrelated work, and never stage the child as a submodule. Workspace plans/docs and product source belong in separate commits when commits are requested.

The active product path is `src/v3/`. `src/v2/` is not an acceptable place for new product behavior. The shared versioned installer currently remains in `src/v2/service.ts` while V2 product routing is removed.

## Toolchain

```bash
corepack pnpm install
pnpm check
pnpm build
```

`pnpm check` runs formatting validation, strict TypeScript, and the complete repository test suite. For iteration, run the focused V3 file directly, then run the full gate.

## Focused proof rules

Keep `test/product.integration.test.ts` at ten tests or fewer. Prefer a complete setup-to-hub-to-adoption-to-apply case over unit tests of private helper shapes or wording.

| Change                   | Required evidence                                             |
| ------------------------ | ------------------------------------------------------------- |
| Recursive scan or ignore | Deep paths, hard exclusions, aliases, unsupported objects     |
| Manifest/object          | Exact round trip, digest rejection, bounded transfer          |
| Authority/enrollment     | Target-local key, signed revision, tamper rejection           |
| Adoption                 | Populated target recovery, source zero mutation, force verify |
| Normal merge             | Causal concurrent edits and visible exact conflict            |
| Directory identity       | Deep rename and zero object upload                            |
| Rename transaction       | File/directory cycles plus case and Unicode spelling changes  |
| Git boundary             | Nested capture/apply/fsck and external-dir rejection          |
| Protocol                 | Local/SSH parity, version mismatch, frame and object bounds   |
| Durability               | Injected source seal, apply, adoption, and cutover restarts   |
| Integrity                | Corrupt hub object rejected before live mutation              |
| Service                  | Explicit test paths, disabled before cutover, exact uninstall |

## Safe roots

Automated tests use `mkdtemp` or a sentinel-qualified run root outside `~/Code`. They never use the default config, active user-local binary, daily-driver hub, service label, real backup fixtures, or existing Code folder.

Real fleet acceptance must use the V3 plan's fresh `~/codefoldersync-v3-runs/<run-id>/` shape with an exact sentinel and separate peer, hub, controller, and evidence directories. Canonical masters are read-only inputs and never cleanup targets.

## Review checklist

- Does authority or peer signature validation still cover the changed meaning?
- Does the hub sequence remain the only causal order?
- Are all referenced objects durable before acceptance?
- Can an unknown response retry the exact event?
- Is every apply target contained and revalidated?
- Is prior live data moved to recovery first?
- Can startup reverse every prepared journal without guessing?
- Are Git boundaries complete rather than leaf-merged?
- Is every stable losing version visible or recoverable?
- Does a failure return non-clean status and preserve evidence?
- Do docs and schema/protocol versions describe the executable truth?

## Release gate

A repository candidate requires format, typecheck, tests, build, the focused V3 scenarios, and current CTX9 docs. A daily-driver release additionally requires every external backup, fixture, pseudo-fleet, real-machine, preview, adoption, and cutover gate in `.agents/plans/codefoldersync-v3-recursive-adoption/plan.md`.

## Documentation routing

- Types, manifests, or SQLite: data model.
- Scan, adoption, merge, apply, or daemon: sync engine.
- Frames, operations, bounds, retry: protocol.
- Outbox, journals, recovery, retention: durability.
- Trust or filesystem boundary: safety.
- Operator-visible conflicts: conflicts.
- Setup or service behavior: installation and operations.
- Proof workload: scenarios and this document.
