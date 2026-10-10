# Synchronization policies

The authority signs the synchronization policy with the folder configuration. Peers and the hub enforce the same scope. Git metadata stays local under both policies. Use Git to share commits and branches.

This is an in-progress replacement for the full-Git mirroring contract. Earlier configurations without a signed policy are rejected. Create fresh configuration, state, and hub identities; do not upgrade a live old folder in place.

## Default-branch only

```sh
codefoldersync setup --mode authority --root /absolute/workspace \
  --hub /absolute/private-hub --backup-witness <verified-id> \
  --sync-policy default-branch --default-branch master
```

Working-file transfer requires the configured branch, matching repository identity, and the exact same HEAD commit. A branch name alone is insufficient. Detached or unborn HEAD, active Git operations, mismatched identity, and different commits stop transfer. Configuration does not switch branches, stage changes, copy an index, rewrite remotes, or install hooks.

Repository context enters the signed snapshot. Apply rechecks the context after remote operations, and interrupted apply checks it before recovery can move a file. Pending work must never be replayed in a different Git context.

During default-branch apply, private Git index, HEAD, and current branch-ref locks prevent cooperating Git commands from switching or committing the checkout. The engine journals its exact nonce-qualified locks outside the workspace and releases them on exit. After a crashed owner process, restart removes only matching locks from that private journal before recovering the apply. A live process, replaced lock, unsafe parent, or ambiguous journal stops recovery. This does not protect against another program directly rewriting Git metadata without Git's locking protocol.

Development gates still open: independently suspending one nested repository without stopping eligible siblings, advancing a context after Git commits without permanently pinning the original HEAD, and complete race/outbox coverage. The initial implementation conservatively stops the whole folder on a mismatched repository. Do not activate it on a daily-driver workspace until those gates and real-folder acceptance pass.

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

The policy integration lane exercises ENV sharing across independently selected branches, retained code/index/HEAD, nested ENV creation and deletion beside local-only files, visible concurrent-value recovery, and matching/default/mismatched Git contexts. Existing grouped product integration scenarios cover adoption, durable apply, structural changes, corruption, and conflicts with independent Git state.

These focused cases do not prove release acceptance. Full archived Code trees, native-machine checks, and real-folder stress results are separate evidence in the rollout plan. Passing them requires the final candidate, not an older build's checkpoint.
