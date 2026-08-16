# CodeFolderSync safety harness

A deterministic, fail-closed black-box test harness for evaluating CodeFolderSync across three isolated peers and nested Git repositories. Alpha and beta run independently on Wootbook; gamma runs on Worker Mac Air.

It answers two separate questions:

1. What does CodeFolderSync itself preserve during delayed and concurrent coding work?
2. Can a small repo-scoped guard stop agent work when safe coordination is uncertain?

The harness does not target existing code. Every workload mutation stays below a sentinel-protected `~/codefoldersync-<peer>-runs/<run-id>` root.

## What it verifies

- exact regular-file bytes, expected paths, recognized conflict sidecars, and executable mode;
- commits, trees, fully qualified refs, backup refs, index trees, worktrees, and `git fsck --full`;
- staged, unstaged, untracked, and committed changes;
- recognized CodeFolderSync conflict sidecars by content, not filename alone;
- agreement across three normalized peer manifests and Git semantic snapshots over consecutive quiet samples;
- the same result after an independently managed foreground-daemon restart;
- durable peer evidence when SSH drops after a write but before controller acknowledgement;
- fail-closed lease denial and child termination after heartbeat expiry.

An orphan Git object does not pass when the journal requires a branch or backup ref. Unknown or interrupted state never becomes a pass by timeout.

## Scenarios

- `serial`: alpha, beta, and gamma take turns from a confirmed common state while propagation is deliberately paused and restarted.
- `conflict`: all three peers write while offline. Raw mode deliberately moves the same Git ref to three commits and verifies whether all branch decisions survive. Guarded mode denies competing work and kills a heartbeat-expired probe before it writes.
- `churn`: three peer workers change separate repositories in parallel while one peer is paused and another daemon restarts. Guarded commits gain unique backup refs.

The fake adapter proves the schedule and oracle. It includes an injected-loss mode that must fail. The live adapter controls three isolated account homes and foreground daemons, and reports raw and guarded outcomes separately.

## Development

```bash
corepack pnpm install
pnpm check
pnpm harness help
```

`pnpm check` runs formatting, strict TypeScript, 25 focused tests, all fake scenarios, injected-loss rejection, live preparation in three local roots, mixed remote-worker churn, hidden-state exclusion, heartbeat termination, and report generation.

## Fleet workflow

Copy `config.example.json` to the ignored `config.local.json` only if machine paths differ.

```bash
pnpm harness doctor --config config.example.json
pnpm harness prepare --config config.example.json --run live-serial-001 --seed 91001
pnpm harness enroll --config config.example.json --run live-serial-001
pnpm harness scenario serial --adapter codefoldersync --mode raw \
  --config config.example.json --run live-serial-001 --seed 91001
pnpm harness detach --config config.example.json --run live-serial-001
```

Use a fresh run ID and prepared CodeFolderSync folder for each scenario/mode. This prevents a prior conflict from contaminating the next result.

`prepare` performs readiness checks, creates sentinel roots, deploys the compiled peer worker inside each root, records filesystem capabilities, and creates three small Git repositories on alpha. It refuses an existing run root.

`enroll` is separate because it changes account state. Alpha must first be authenticated interactively. Beta and gamma use fresh account homes below their run control directories. Pairing output is streamed directly from the source link process to each target join process and is not captured or persisted. Version 0.13.0 exposes the short-lived ticket in the target process argument list, so live peers must be dedicated worker users without untrusted local processes.

Live scenario output is written to `results/<run-id>/result.json`. Sensitive enrollment output and raw logs are never stored there.

## Run layout

```text
~/codefoldersync-<peer>-runs/<run-id>/
  .codefoldersync-run.json
  workspace/   CodeFolderSync registration, three generated Git repositories
  control/     peer journal, capability probe, supervisor state
  tools/       compiled peer worker
```

The controller journal lives in alpha's `control/`. Each peer flushes `started`, `observed`, and `completed` witnesses before acknowledging the controller. Final verification aggregates all peer witnesses outside the synced workspace.

The harness does not automatically remove run roots or delete remote data. `detach` stops sentinel-owned daemons and removes only local folder registrations. Failed fixtures remain available for diagnosis.

## Current validation

See [results/2026-08-16-local-validation.md](results/2026-08-16-local-validation.md).
