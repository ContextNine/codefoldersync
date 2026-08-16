# CodeFolderSync V2 scale and fleet acceptance

Verdict: pass.

The isolated three-machine run exercised a 100,000-small-file, three-repository workspace with large files, executable modes, empty directories, exact symlinks, transactional Git state, real SSH transport, real systemd and launchd services, deliberate interruption, immediate saves, deterministic conflicts, and 10,000 independent agent operations. No existing `~/Code`, default configuration, daily-driver service, or production system was used.

The first latency attempt exposed real design problems rather than being accepted as noise: a remote-apply temporary filename entered the watcher, rapid saves could retain an outdated causal baseline, and four roughly 540 ms WireGuard round trips made a correct save too slow. The fixes were reserved-path suppression, explicit advancement of the accepted content baseline without hiding a newer filesystem observation, and a bounded single publish exchange that sends only objects absent from the accepted baseline. The repeated 25-save run preserved every version with p50 968 ms, p95 1.31 s, max 1.33 s, and zero false conflicts.

The intentional three-way conflict retained Alpha at `real-conflict.txt` and created one deterministic, grep-friendly sibling for each of Beta and Gamma. All three exact byte sequences and all Git semantics converged to the same independent digest. The siblings were then preserved in the test recovery area and their normal filesystem removal returned every peer to clean.

The mixed workload completed exactly 10,000 high-level operations across three independent repositories. Final verification found 109,889 files, 126 directories, 69 symlinks, zero conflicts, identical worktree digest `1581b7ce8206034acbcbcaf50118e934028ca78c99366c4d38dd4091f7890e17`, matching refs/indexes, and nine clean `git fsck --full` results. A middle edit to the 64 MiB file published one event and two objects using 283 compressed wire bytes.

The focused V2 suite remains six integration tests; the complete repository suite passed 31 of 31. The run-qualified systemd unit and launchd label were both absent after explicit uninstall, with their definitions retained under recovery.
