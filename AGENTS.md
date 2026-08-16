# AGENTS.md

This repository is a destructive-systems test harness. Keep it small, deterministic, and fail closed.

- Never target an existing code folder or CodeFolderSync registration.
- Workload mutations may occur only below a validated `~/codefoldersync-<peer>-runs/<run-id>` root containing the matching sentinel. Setup is limited to the user-local binary alias and explicitly authorized source-account login.
- Never print, persist, or commit CodeFolderSync enrollment tickets, tokens, keys, or recovery codes.
- Keep controller journals and peer witnesses outside the synced `workspace/` directory.
- An unreachable peer, ambiguous status, journal disagreement, stale baseline, or expired lease must prevent a passing verdict.
- Do not automatically delete run roots or remote CodeFolderSync data during closeout. Local folder detachment is allowed after evidence capture.
- Tests must include a fault that loses work and prove the verifier rejects it.
- Use per-command fixture Git identity. Do not read or change global Git configuration.

Run `pnpm check` before committing.
