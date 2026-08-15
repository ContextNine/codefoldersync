# TreeSync safety harness

A deterministic, fail-closed black-box test harness for evaluating TreeSync across three real machines and nested Git repositories.

It answers two separate questions:

1. What does TreeSync itself preserve during delayed and concurrent coding work?
2. Can a small repo-scoped guard stop agent work when safe coordination is uncertain?

The harness does not target existing code. Every mutation stays below a sentinel-protected `~/treesync-safety-harness-runs/<run-id>` root.

## What it verifies

- regular-file bytes and executable mode;
- commits, trees, fully qualified refs, backup refs, index trees, worktrees, and `git fsck --full`;
- staged, unstaged, untracked, and committed changes;
- recognized TreeSync conflict sidecars by content, not filename alone;
- agreement across three normalized peer manifests over consecutive quiet samples;
- the same result after a TreeSync service restart;
- durable peer evidence when SSH drops after a write but before controller acknowledgement;
- fail-closed lease denial and child termination after heartbeat expiry.

An orphan Git object does not pass when the journal requires a branch or backup ref. Unknown or interrupted state never becomes a pass by timeout.

## Scenarios

- `serial`: alpha, beta, and gamma take turns from a confirmed common state while TreeSync propagation is deliberately paused and restarted.
- `conflict`: all three peers write while offline. Raw mode deliberately moves the same Git ref to three commits and verifies whether all branch decisions survive. Guarded mode denies competing work and kills a heartbeat-expired probe before it writes.
- `churn`: three workers change separate repositories in parallel while one TreeSync peer is paused and another service restarts. Guarded commits gain unique backup refs.

The fake adapter proves the schedule and oracle. It includes an injected-loss mode that must fail. The live adapter controls the installed TreeSync CLI and reports raw and guarded outcomes separately.

## Development

```bash
corepack pnpm install
pnpm check
pnpm harness help
```

`pnpm check` runs formatting, strict TypeScript, 20 focused tests, all fake scenarios, injected-loss rejection, live preparation in three local roots, and heartbeat termination.

## Fleet workflow

Copy `config.example.json` to the ignored `config.local.json` only if machine paths differ.

```bash
pnpm harness doctor --config config.example.json
pnpm harness prepare --config config.example.json --run live-serial-001 --seed 91001
pnpm harness enroll --config config.example.json --run live-serial-001
pnpm harness scenario serial --adapter treesync --mode raw \
  --config config.example.json --run live-serial-001 --seed 91001
```

Use a fresh run ID and prepared TreeSync folder for each scenario/mode. This prevents a prior conflict from contaminating the next result.

`prepare` performs readiness checks, creates sentinel roots, deploys the compiled peer worker inside each root, records filesystem capabilities, and creates three small Git repositories on alpha. It refuses an existing run root.

`enroll` is separate because it changes TreeSync account state. Alpha must first be authenticated interactively. Enrollment refuses to control a peer with any existing synced folder. Pairing output is streamed directly from `treesync link` to the target `treesync join` process and is not captured or persisted. TreeSync v0.13.0 exposes the short-lived ticket in the target process argument list, so live peers must be dedicated worker users without untrusted local processes.

Live scenario output is written to `results/<run-id>/result.json`. Sensitive enrollment output and raw logs are never stored there.

## Run layout

```text
~/treesync-safety-harness-runs/<run-id>/
  .treesync-safety-run.json
  workspace/   TreeSync registration, three generated Git repositories
  control/     peer journal, capability probe, supervisor state
  tools/       compiled peer worker
```

The controller journal lives in alpha's `control/`. Each peer flushes `started`, `observed`, and `completed` witnesses before acknowledging the controller. Final verification aggregates all peer witnesses outside the synced workspace.

The harness does not automatically remove run roots or use `treesync remove --delete-remote`. Failed fixtures remain available for diagnosis.

## Current validation

See [results/2026-08-15-local-validation.md](results/2026-08-15-local-validation.md).
