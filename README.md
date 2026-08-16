# CodeFolderSync

CodeFolderSync keeps a parent folder of Git repositories synchronized across your machines. It has no account, signup, browser flow, hosted control plane, or proprietary sync service. Peers use your existing SSH access and a hub directory on a machine you control.

Ordinary files sync as soon as they are saved. CodeFolderSync does not perform line-level merging. If two machines change the same file from the same base, the hub keeps the first accepted version at the original path and preserves every other version beside it:

```text
settings.json
settings.CODEFOLDERSYNC-CONFLICT.laptop.91fd30a2.json
```

The marker is deliberately grep-friendly:

```bash
rg --files ~/Code | rg 'CODEFOLDERSYNC-CONFLICT'
find ~/Code -name '*CODEFOLDERSYNC-CONFLICT*'
```

## How it works

- A native filesystem watcher queues a saved path immediately. A periodic metadata reconciliation catches missed or overflowed watcher events.
- Regular files use streaming content-defined chunks. Unchanged chunks are never retransmitted.
- New objects and one saved-file event travel in one bounded publish exchange over a persistent framed SSH process. Accepted baseline chunks are not resent.
- Symlinks synchronize their exact target text and are never followed.
- Directories have stable identities, so renaming a large directory is one metadata event rather than one operation per descendant.
- Every accepted mutation is causally based and idempotently identified. The hub, not a client clock, chooses the canonical version.
- `.git` data transfers incrementally but stages, validates, and swaps as one transaction. Concurrent Git states are preserved as explicit Git conflicts rather than merged file by file.
- Local state, hub metadata, object bytes, the outbox, conflicts, and apply journals use durable SQLite or immutable content storage.

The hub contains plaintext repository data and inherits the hub machine's filesystem permissions and backups. SSH authenticates and encrypts transport.

## Install

CodeFolderSync currently requires Node.js 22 or newer. Build and install a versioned copy:

```bash
corepack pnpm install
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync --version
```

The installer copies the build to `~/.local/lib/codefoldersync/0.2.0/` and atomically activates `~/.local/bin/codefoldersync`. The wrapper records the absolute Node executable used during installation, so launchd/systemd and noninteractive shells do not depend on nvm or shell startup files.

Install the same build on the hub machine before configuring an SSH hub. `upgrade` installs another versioned build, and `rollback --version <version>` only changes the active wrapper.

## Setup wizard

Run this on the first machine:

```bash
~/.local/bin/codefoldersync setup
```

The wizard asks whether to create or join, which parent folder to synchronize, where the local or SSH hub lives, and the peer name. It probes case behavior, Unicode aliases, atomic rename, fsync, and symlink support before saving configuration. It can install and start a per-folder user service at the end.

There is no login step.

For automation, use the same validation path with flags:

```bash
codefoldersync setup \
  --mode create \
  --root /absolute/path/to/code \
  --hub ssh://user@hub-host/absolute/path/to/hub \
  --name my-code \
  --peer laptop
```

The result prints a folder ID. On another machine, point an empty destination at the same hub:

```bash
codefoldersync setup \
  --mode join \
  --folder-id <folder-id> \
  --root /absolute/path/to/empty/code \
  --hub ssh://user@hub-host/absolute/path/to/hub \
  --peer desktop
```

SSH hubs default to `~/.local/bin/codefoldersync` on the remote host. Advanced or test installations can override this with `--remote-command` and `--remote-node`.

The synchronized root may contain only direct-child repositories with an in-tree `.git` directory, plus an optional `.codefoldersyncignore`. Product state and the hub must be outside that root and on the same filesystem as the root when atomic recovery requires it.

## Routine operation

```bash
codefoldersync doctor
codefoldersync status
codefoldersync sync
codefoldersync verify --full
codefoldersync service status
codefoldersync service logs
```

The foreground daemon is also available for a custom supervisor:

```bash
codefoldersync daemon --config /absolute/path/to/config.json
```

The daemon is the only allowed writer for its configured folder. A mutating foreground command fails closed while the daemon is active; stop the service first for deliberate maintenance and start it again afterward.

Manage the generated user-level launchd or systemd service with:

```bash
codefoldersync service install
codefoldersync service start
codefoldersync service restart
codefoldersync service stop
codefoldersync service uninstall
```

Uninstalling a service does not delete synchronized files, configuration, local objects, recovery data, or hub state.

Repository membership and ignore rules are explicit:

```bash
codefoldersync repository add new-repo
codefoldersync repository remove old-repo
codefoldersync repository refresh
codefoldersync ignore push
codefoldersync ignore pull
```

Removing repository membership never deletes the repository from disk.

## Conflicts and recovery

List ordinary and Git conflicts:

```bash
codefoldersync conflicts
codefoldersync history atlas
```

Ordinary-file conflicts already exist as normal sibling files and need no product-specific merge command. Inspect them, keep or combine the content you want, and delete the extra copy like any other file.

Git metadata conflicts are whole validated `.git` states. Select one explicitly:

```bash
codefoldersync resolve-git <conflict-id> --take canonical
codefoldersync resolve-git <conflict-id> --take conflict
```

Recover any retained manifest without changing the synchronized folder:

```bash
codefoldersync recover <manifest-or-conflict-id> --to /absolute/empty/path
```

Offline edits remain in the durable outbox. Corrupt objects, unsafe paths, ambiguous local changes, protocol mismatch, disk errors, and failed Git validation stop affected work without replacing the local version.

Garbage collection is report-only in V2:

```bash
codefoldersync gc --dry-run
```

Automatic deletion is disabled. `migrate-v1 --dry-run --root <path>` provides a read-only inventory for side-by-side migration to a fresh V2 folder and hub.

## Verification

The focused V2 suite contains six integration tests covering incremental chunks and symlinks, deterministic conflicts and directory moves, transactional Git states and corruption rejection, setup/install/services/repository membership, watcher latency, and three-peer churn. The repository also retains the earlier adversarial safety-harness tests.

```bash
pnpm check
```

Fleet and scale evidence is committed under `results/`, including the 100k-file, sub-two-second latency, deterministic three-way conflict, and 10,000-operation V2 run. Tests use generated, sentinel-protected roots outside every machine's `~/Code`.
