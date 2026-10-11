# Complete archived-folder stress

`scripts/run_full_folder_stress.mjs` exercises complete disposable Impression and
Verascient folders after the original full-Code campaign passes. It does not
register or edit live Code folders, install a default binary, or enable a service.
The tested runtime comes from the exact accepted release archive, not the
coordinator's source checkout.

Impression uses `default-branch` with `master`. Verascient uses the explicitly
approved plaintext ENV-only policy across different branches. The plaintext
exception applies only to Verascient. Actual archived values stay inside private
test workspaces, state, recovery, and the hub. Output contains counts, hashes,
timings, and pass flags, never file contents or path manifests.

## Required input

Run `node scripts/run_full_folder_stress.mjs /absolute/private/spec.json` as the
registered unprivileged UID within an already prepared private Btrfs namespace.
`scripts/run_archived_folder_stress.mjs controller /absolute/private/spec.json`
owns image allocation, authenticated archive extraction, mount lifetime, and
final volume cleanup. Invoke it as root inside a fresh private mount namespace;
the actual restore and stress commands run as the registered unprivileged UID.
The inner stress driver never formats or mounts storage.

The controller requires the same-candidate original full-Code acceptance receipt
and protected folder witnesses before allocating anything. Its specification
adds the Wootbook original `source` ciphertext and complete parent witness,
`snapshotId`, protected `identityPath`, approved managed `downloadCommand`, and
the physical historical `restoreScript` plus its SHA-256. It also supplies
`runParent`, `evidenceDirectory`, `uid`, `gid`, `seed`, `inheritedMountNamespace`,
non-overlapping `retainedRoots`, and page-aligned `maximumImageBytes`. It refuses
Code write targets and a maximum image plus retained allocation and control
reserve above 200 GiB. Do not launch while another bulk acceptance volume is
active. Reinventory retained roots after the earlier controller finishes.

The historical restore helper downloads and authenticates the entire original
Wootbook Code archive into one reserved slot. No partial archive extraction or
current live copy substitutes for the full parent. The controller initially
reduces its image maximum by the download slot allowance, then grows only its
proved matching backing image after that exact slot has been removed. The image
size stays fixed during stress. All included and excluded folder bytes remain
present in three mandatory-reflink peers per repetition.

Both cases run sequentially with empty object stores and fresh peer state. A
run-qualified inner sentinel root owns all installed test tools, peer roots,
templates, and case evidence, and is removed before the outer volume teardown.
Only bounded sanitized case results escape in the controller result. All child
commands drain before unmount; the exact volume is removed after success or
failure. No original archive, live Code tree, default install, or service is
removed by controller cleanup.

The schema-version-1 specification supplies:

- `caseId`, either `impression` or `verascient`; `corpus`, either
  `complete-original-folder` or `public-fixture`.
- A physical `runRoot` with its matching `runId` sentinel and a fresh private
  `evidenceDirectory`.
- `candidateArchive`, its `candidateSha256`, the extracted `packageRoot`, and
  `command` for its privately installed binary. The archive must hash correctly.
- A complete protected `masterRoot` and its exact `masterWitness` from
  `createTreeWitness`. Root modes must remain read-only.
- `repetitions: 2`, `rounds`, `uid`, `seed`, the protected hash-pinned
  `nativeFaultLibrary`, and the bounded-reflink `storage` specification described
  in [Full-view storage](full-view-storage.md).

Real input requires at least 24 rounds per repetition and a successful original
full-Code `originalAcceptanceReceipt` for the same candidate hash. It must name
`originalSnapshotId: codefoldersync-backup-20260825T102132Z` and
`originalMachineId: wootbook`. Extract the entire `Code/impression` and
`Code/verascient` folders from that verified original ciphertext and match their
protected subtree witnesses captured from the full parent restore. Supply the
bounded `originalFolderWitnessReceipt` from that capture. Its original Wootbook
parent witness must match the successful full-Code receipt, and its folder
witness must match this input's `masterWitness`. Never replace
them with current live copies, sampled files, or generated input.

Public fixture input allows two rounds, has `acceptanceCorpus: false`, and cannot
close an original-data gate. The storage validator still requires a protected
object-template database. Folder stress starts with empty peer and hub stores;
it does not preseed objects from that template.

## Scoped ignore projection

Every disposable peer retains the entire folder, including dependencies and
machine-local Git metadata. The runner adds an explicit `/node_modules/` ignore
rule to each peer's existing ignore source before authority setup. The current
`**/node_modules/` default matches nested paths but does not exclude a direct
repository-root `node_modules`. Ignored bytes remain present and witnessed; they
are not trimmed or synchronized.

Activation uses the packaged `setup --mode activate --ignore` command with the
accepted private configuration and target-local enrollment request. The existing
distributed helper supplies only the default ignore source, so it cannot activate
this custom projection. No runtime patch or unverified in-process activation is
used. A later scoped pilot must explicitly project the same authority-approved
ignore source to its targets.

## Workload and proof

Each repetition makes three independent mandatory-reflink copies of the complete
master. Identity, keys, catalog, history, and configuration are fresh. Each peer
has private HOME/XDG directories and disables global and system Git configuration.
Test branch and staging preparation applies only to these disposable copies.
Synthetic index entries use `hash-object --no-filters` and `update-index`, not a
command that executes archived clean filters. Fixture Git commands disable hooks,
fsmonitor, and network protocols.

The workload rotates writers, converges exact new bytes, and checks local Git
metadata after each sustained round. It then requires visible exact losing
conflict bytes, unavailable-hub rejection and retained offline edits, real SIGKILL
recovery after outbox persistence and hub acceptance, policy-specific branch
transitions, native ENOSPC/EIO recovery, corruption rejection, and interrupted
subtree-move recovery without object upload.

Final force verification covers every peer's included namespace at the same hub
sequence. A no-change sync must publish nothing and transfer zero objects. Each
peer's original Git metadata and all unselected or ignored bytes must match its
own initial witness. Git object checks run on discovered, unignored repositories.
Ignored fake Git markers remain ordinary witnessed local data. Both repetitions
must have the same workload digest, and the complete protected master witness
must remain unchanged.

Each repetition's exact sentinel root is removed before the next. The run root is
removed on success or failure. Successful bounded private results are retained
outside that root; the outer controller must retain them before volume teardown.
A green public fixture or a successful archive download does not establish real
full-folder acceptance.

The existing native storage fixture invokes
`test/fixtures/full-folder-stress.mjs` for both policies through the complete
controller lifecycle. Its protected complete public parent contains both
folders, including an ignored malformed Git marker and failing Git hooks/filters
to exercise safe staging and traversal. It encrypts that parent, restores it
through the historical helper, runs both cases as an unprivileged peer inside a
new nested private namespace, and checks the unchanged parent and ciphertext
plus exact volume cleanup. This adds no top-level product test group and does
not certify an original archive or overall fleet capacity.
A second controller invocation corrupts only its fresh downloaded ciphertext.
It must reject before stress, remove the exact failed volume, and retain the
original fixture ciphertext unchanged.
