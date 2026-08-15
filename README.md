# TreeSync safety harness

A deterministic, fail-closed black-box test harness for evaluating TreeSync across three real machines and nested Git repositories.

The harness tests:

- delayed serial handoff;
- partitioned concurrent conflicts;
- sustained multi-agent changes across repositories;
- filesystem-byte and Git-semantic preservation;
- a conservative repo-scoped write guard.

It never targets an existing code folder. Test runs live below `~/treesync-safety-harness-runs/<run-id>` on isolated worker machines.

## Development

```bash
corepack pnpm install
pnpm check
pnpm harness help
```

The full operating and safety contracts live in the parent CTX9 workspace documentation while the first implementation is developed.
