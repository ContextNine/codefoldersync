# Local validation, 2026-08-16

## Result

The renamed deterministic core, three-peer topology, run-scoped account isolation, foreground-daemon controller, and live preparation path pass locally. Live scenarios await the source account's browser consent callback.

## Automated checks

Command:

```bash
pnpm check
```

Result:

```text
format: pass
typecheck: pass
tests: 25 passed, 0 failed
```

The test suite covers:

- serial raw fake scenario;
- conflict raw and guarded fake scenarios;
- guarded churn fake scenario;
- injected completed-operation loss rejected on all three peers;
- missing file canary detection;
- token-preserving byte alteration and unexplained path movement rejected;
- modify/delete outcomes classified and unapplied delete intent rejected;
- divergent peer filesystem and Git semantic state rejected;
- staged index trees required in the live index or an explicit backup ref;
- surviving commit object with lost branch meaning rejected;
- missing guard backup ref rejected;
- controller/peer journal disagreement;
- lost SSH acknowledgement recovered from peer witness;
- ambiguous started work rejected;
- explicit interruption classified without becoming completed;
- repo-scoped lease contention, stale baseline, peer uncertainty, and expiry;
- heartbeat-expired child terminated before its delayed write;
- unsafe run IDs and cleanup without a matching sentinel rejected;
- compiled live worker deployed and executed in three isolated local run roots;
- sentinel-owned foreground daemon start and exact-PID stop;
- compiled worker exercised create, append, replace, rename, delete, chmod, stage, unstage, branch, and commit operations.

## Fleet doctor

CodeFolderSync version: `0.13.0`.

| Peer  | Host                       | Result                                        |
| ----- | -------------------------- | --------------------------------------------- |
| alpha | Wootbook                   | v0.13.0, Linux x86-64, ready; consent pending |
| beta  | Wootbook isolated run home | v0.13.0, Linux x86-64, ready                  |
| gamma | Worker Mac Air             | v0.13.0, macOS arm64, reachable and ready     |

Worker Mac Air received the official v0.13.0 darwin/arm64 binary through CodeFolderSync's checksum-verifying installer. Installed binary SHA-256:

```text
d2a0d258445c39a8c125d7864c9f57a169fa248c2a2a97a620cae23ed1b18d50
```

Wootbook's v0.13.0 linux/amd64 binary SHA-256:

```text
7b377edf4e55bd4edb910f098498686840663fb1df49a26d41ec694641fcf7e7
```

## Remaining live gate

1. Complete alpha's browser consent callback for the dedicated test account.
2. Prepare a fresh run.
3. Enroll beta and gamma through the non-capturing link/join pipe.
4. Run serial raw, conflict raw, conflict guarded, and guarded churn using separate run IDs.

No existing CodeFolderSync folder, code folder, or Git repository has been enrolled or changed.
