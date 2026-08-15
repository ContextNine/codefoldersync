# AGENTS.md

This repository is a destructive-systems test harness. Keep it small, deterministic, and fail closed.

- Never target an existing code folder or TreeSync registration.
- Mutations may occur only below a validated `~/treesync-safety-harness-runs/<run-id>` root containing the matching sentinel.
- Never print, persist, or commit TreeSync enrollment tickets, tokens, keys, or recovery codes.
- Keep controller journals and peer witnesses outside the synced `workspace/` directory.
- An unreachable peer, ambiguous status, journal disagreement, stale baseline, or expired lease must prevent a passing verdict.
- Do not automatically delete run roots or remote TreeSync data during closeout.
- Tests must include a fault that loses work and prove the verifier rejects it.
- Use per-command fixture Git identity. Do not read or change global Git configuration.

Run `pnpm check` before committing.
