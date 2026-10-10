# Synchronization policies

The authority signs the synchronization policy with the folder configuration. Peers and the hub enforce the same scope. Git metadata stays local under both policies. Use Git to share commits and branches.

This is an in-progress replacement for the full-Git mirroring contract. Earlier configurations without a signed policy are rejected. Create fresh configuration, state, and hub identities; do not upgrade a live old folder in place.

## Default-branch only

```sh
codefoldersync setup --mode authority --root /absolute/workspace \
  --hub /absolute/private-hub --backup-witness <verified-id> \
  --sync-policy default-branch --default-branch master
```

Working-file transfer requires the configured branch, matching repository identity, and the exact same HEAD commit. A branch name alone is insufficient. Detached or unborn HEAD, active Git operations, mismatched identity, and different commits suspend the affected repository. Configuration does not switch branches, stage changes, copy an index, rewrite remotes, or install hooks.

The most deeply nested repository owns each path. An eligible nested repository can transfer files while its parent is off-branch, and eligible siblings continue independently. The hub retains suspended scope unchanged. Locally, each suspended repository keeps its previous baseline and catalog instead of accepting an unseen remote version. `sync` and `verify --full` report `inconclusive` with repository reasons while any scope is suspended, even when eligible files transferred successfully. Newly discovered or locally missing repositories pause until their context is enrolled.

Repository context enters the signed snapshot. Apply rechecks the context after remote operations, and interrupted apply checks it before recovery can move a file. Pending work must never be replayed in a different Git context.

During default-branch apply, private Git index, HEAD, and current branch-ref locks prevent cooperating Git commands from switching or committing the checkout. The lease also guards enclosing repositories in their existing branch context, since a parent checkout could change files inside a nested repository. An enclosing Git mutation pauses its nested scopes until it finishes. The engine journals its exact nonce-qualified locks outside the workspace and releases them on exit. After a crashed owner process, restart removes only matching locks from that private journal before recovering the apply. A live process, replaced lock, unsafe parent, or ambiguous journal stops recovery. This does not protect against another program directly rewriting Git metadata without Git's locking protocol.

Mixed-context outbox records remain private while a repository is suspended. Eligible siblings can publish a fresh proposal against the current hub sequence. Returning to the original context resumes the existing CAS retry/merge flow without replaying a stale accepted version over newer sibling work. Immutable objects remain retained.

Development gates still open: advancing a context after Git commits without permanently pinning the original HEAD, and isolating a suspended repository inside an already interrupted multi-repository apply. A pending apply currently stops recovery for the folder if any of its active or enclosing contexts changed. Additional context-transition coverage and obsolete Git-mirroring removal remain required. Do not activate this development build on a daily-driver workspace before those gates and real-folder acceptance pass.

## Selected files only

```sh
codefoldersync setup --mode authority --root /absolute/workspace \
  --hub /absolute/private-hub --backup-witness <verified-id> \
  --sync-policy selected-files --include '.docs/**' --include 'notes/*.md'
```

Patterns are root-relative. `*` matches within one path component, `?` matches one non-separator character, and `**` crosses directories. A leading globstar directory prefix also matches files directly in the root. A trailing slash includes a subtree. Repeat `--include` for multiple patterns. Exclusions from the signed ignore contract still apply.

Only selected leaf contents, required parent directories, and explicitly selected physically empty directories enter the namespace. Local-only siblings remain in place during structural recovery; directories containing them cannot be renamed as a bulk operation. Selected working files may cross branches intentionally, and tracked selected files can therefore become dirty on the receiving branch. This mode preserves local Git metadata, not the cleanliness of the checkout.

Current programmatic setup defaults to selected-files with `**`, with plaintext ENV sharing disabled. Specify the policy explicitly for a rollout. Fleet and distributed setup specs accept the same `syncPolicy` object; setup resume rejects a changed policy.

Interactive setup asks for the policy, branch or allowlist before enrollment. It requires separate plaintext ENV consent. Selected-files discovery excludes Git metadata without requiring a committed HEAD or an idle Git index, so an unrelated unborn or busy repository does not suspend ENV sharing. A selected symlink transfers only its target text; applying its permissions must not touch the referenced local file.

## Explicit plaintext ENV sharing

```sh
codefoldersync setup --mode authority --root /absolute/approved-workspace \
  --hub /absolute/private-hub --backup-witness <verified-id> \
  --sync-policy plaintext-env --allow-plaintext-env
```

The preset selects `.env` and plaintext environment variants at any depth. Public `.env.base`, example/sample/template filenames, and encrypted SOPS/age/GPG filenames do not enter this preset. Ordinary default-branch and selected-files policies do not transfer plaintext ENV unless the selected-files policy explicitly opts in.

Plaintext ENV transfer needs a separate custody decision for the exact workspace. Opting in means values exist in peer files, immutable hub objects, conflict history, and recovery, not only in the latest working file. Root/state/hub directories must be private to the owner, materialized ENV files use mode `0600`, and remote transfer uses authenticated SSH. Values must never enter CLI output, committed evidence, public artifacts, screenshots, or plaintext cloud backups. Automated cases use synthetic values.

## Acceptance

The policy integration lane exercises ENV sharing across independently selected branches, retained code/index/HEAD, nested ENV creation and deletion beside local-only files, and visible concurrent-value recovery. Its default-branch scenario covers matching contexts, independently paused nested roots, reverse sibling publication, an unborn/locked sibling, native checkout exclusion, mixed-context queues, and real SIGKILL/restart with a partial apply. Existing grouped product integration scenarios cover adoption, durable apply, structural changes, corruption, and conflicts with independent Git state.

These focused cases do not prove release acceptance. Full archived Code trees, native-machine checks, and real-folder stress results are separate evidence in the rollout plan. Passing them requires the final candidate, not an older build's checkpoint.
