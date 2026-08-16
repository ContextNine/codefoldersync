# AGENTS.md

This repository owns the CodeFolderSync product and its destructive-systems safety harness. Keep both small, deterministic, and fail closed.

- CodeFolderSync has no hosted control plane. Do not add accounts, browser authorization, billing, or an external sync binary.
- Treat a complete direct-child Git repository as the synchronization transaction. Never reconcile individual `.git` files.
- A stale compare-and-swap parent, unreachable hub, corrupt snapshot, ambiguous local state, unsupported filesystem object, or unresolved divergence must stop that repository.
- Preserve immutable snapshots, conflict records, and recovery data by default.
- Harness mutations may occur only below a validated `~/codefoldersync-<peer>-runs/<run-id>` root containing the matching sentinel.
- Never target an existing code folder, global CodeFolderSync configuration, user-local binary, or Mattbook.
- Keep controller journals and peer witnesses outside the synchronized `workspace/` directory.
- Tests must include deliberate work loss/corruption and prove the verifier rejects it.
- Use per-command fixture Git identity. Do not read or change global Git configuration.

Run `pnpm check` before committing.
