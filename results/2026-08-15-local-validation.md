# Local validation, 2026-08-15

## Result

The deterministic core and live preparation path pass locally. Live TreeSync scenarios have not run yet because Mac mini is unreachable and alpha needs interactive TreeSync authentication.

## Automated checks

Command:

```bash
pnpm check
```

Result:

```text
format: pass
typecheck: pass
tests: 24 passed, 0 failed
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
- compiled worker exercised create, append, replace, rename, delete, chmod, stage, unstage, branch, and commit operations.

## Fleet doctor

TreeSync version: `0.13.0`.

| Peer                  | Result    | Detail                                                      |
| --------------------- | --------- | ----------------------------------------------------------- |
| alpha, Wootbook       | CLI ready | Linux x86-64, Git 2.53.0, Node 22.23.1, TreeSync logged out |
| beta, Mac mini        | blocked   | SSH/WireGuard address `10.13.13.3` timed out                |
| gamma, Worker Mac Air | CLI ready | macOS arm64, Git 2.50.1, Node 26.6.0, TreeSync logged out |

Worker Mac Air received the official v0.13.0 darwin/arm64 binary through TreeSync's checksum-verifying installer. Installed binary SHA-256:

```text
d2a0d258445c39a8c125d7864c9f57a169fa248c2a2a97a620cae23ed1b18d50
```

Wootbook's v0.13.0 linux/amd64 binary SHA-256:

```text
7b377edf4e55bd4edb910f098498686840663fb1df49a26d41ec694641fcf7e7
```

## Remaining live gate

1. Bring Mac mini online and reachable at `10.13.13.3`.
2. Install the same checksum-verified TreeSync v0.13.0 binary there.
3. Run fleet doctor until all three peers pass.
4. Prepare a fresh run.
5. Authenticate alpha with the dedicated TreeSync test account.
6. Enroll beta and gamma through the non-capturing link/join pipe.
7. Run serial raw, conflict raw, conflict guarded, and guarded churn using separate run IDs.

No existing TreeSync folder, code folder, or Git repository has been enrolled or changed.
