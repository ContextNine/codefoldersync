# AGENTS.md

This repository owns the CodeFolderSync product and its destructive-systems safety harness. Keep both small, deterministic, and fail closed.

- CodeFolderSync has no hosted control plane. Do not add accounts, browser authorization, billing, or an external sync binary.
- Synchronize one recursively discovered namespace through immutable V3 manifests and causally based signed checkpoints. Never reconcile individual `.git` files; each discovered contained Git directory applies as one validated transaction.
- A stale compare-and-swap parent creates deterministic keep-both conflict entries. An unreachable hub, corrupt object, ambiguous local state, or unsafe filesystem traversal must retain queued work and fail closed for the affected path.
- Preserve immutable objects, event history, conflict records, and recovery data by default.
- Scan symlinks with `lstat`, store only their target text, and never follow them during capture or apply.
- Conflict copies must retain exact bytes and use the grep-friendly `CODEFOLDERSYNC-CONFLICT` name contract.
- Harness mutations may occur only below a validated run root containing the matching sentinel. Tests must never register, scan, or mutate an existing `~/Code` folder on any machine.
- Never target an existing code folder, global CodeFolderSync configuration, user-local binary, or daily-driver service on any machine.
- Keep controller journals and peer witnesses outside the synchronized `workspace/` directory.
- Tests must include deliberate work loss/corruption and prove the verifier rejects it.
- Use per-command fixture Git identity. Do not read or change global Git configuration.

Repository-specific documentation lives in `docs/`. Update the relevant document with sync-engine, protocol, storage, recovery, safety, installation, operations, or verification changes and keep `docs/README.md` current.

Keep the focused V3 product integration suite at ten tests or fewer. Run `pnpm check` before committing.
