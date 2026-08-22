# CodeFolderSync

CodeFolderSync V3 recursively synchronizes an included Code folder across trusted machines. It discovers ordinary directories and Git repositories at any depth, uses a self-hosted local or SSH hub, and has no account or hosted control plane.

V3 is incompatible with V1 and V2. It uses schema and protocol version 3, a fresh folder ID, a fresh hub, signed configuration, new state, and a source-authoritative adoption workflow for populated targets.

## Safety model

- The initial authority seals one checkpoint. Targets cannot publish during adoption.
- Target-only and divergent data moves to target-local `adoption-recovery` before canonical materialization.
- Adoption never applies target state to the authority root.
- Normal concurrent writes use the accepted hub checkpoint as the canonical side and preserve the other complete version under a `CODEFOLDERSYNC-CONFLICT` path.
- File objects, manifests, event history, conflicts, and recovery are retained. Garbage collection is report-only.
- Symlinks synchronize target text and are never followed.
- Every contained `.git` boundary is captured and applied transactionally after `git fsck --full`. External Git directories stop setup or synchronization.
- `.codefoldersync` and `.workspace-sync` are hard exclusions. `node_modules` is excluded by the generated default contract.

## Install

CodeFolderSync requires Node.js 22 or newer. Download the release archive and checksum from [GitHub Releases](https://github.com/MDerman/codefoldersync/releases), verify them, extract the archive, then run:

```bash
python3 codefoldersync-0.3.0/scripts/install.py
codefoldersync --version
```

The release installer is idempotent and supports `--verify --json`. It installs a versioned build under `~/.local/lib/codefoldersync` and activates `~/.local/bin/codefoldersync` without requiring a repository checkout.

Git is required for synchronized Git boundaries, and SSH is required for a remote hub. For development, pnpm builds and installs the current checkout:

```bash
corepack pnpm install
pnpm check
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync --version
```

The installer copies the build to `~/.local/lib/codefoldersync/0.3.0/` and atomically activates `~/.local/bin/codefoldersync`. The wrapper records the absolute Node executable used during installation, so launchd/systemd and noninteractive shells do not depend on nvm or shell startup files. Install the same exact build on every peer and the hub host.

## Populated-fleet setup

Interactive setup prompts for the authority and every populated target, requires a verified encrypted-backup witness ID and final approval, performs enrollment and adoption, and stops before cutover with services disabled:

```bash
codefoldersync setup
```

The authority-only primitive remains available for staged or distributed operation:

```bash
codefoldersync setup \
  --mode authority \
  --root /absolute/path/to/Code \
  --hub /absolute/path/to/new-hub \
  --backup-witness <verified-witness-id> \
  --peer mattbook
```

Setup creates authority-controlled files below each selected root:

```text
.codefoldersyncignore
.codefoldersync/config.json
.codefoldersync/authority.json
.codefoldersync/README.txt
```

Runtime state lives outside the synchronized namespace and must share its filesystem with the root. The interactive wizard defaults to a hidden sibling of each root; authority-only setup defaults to `~/.local/state/codefoldersync/<folder-id>/` and rejects it when it is on a different filesystem.

For a controller that can see every isolated root, the same complete populated-fleet ceremony is scriptable:

```bash
codefoldersync setup --mode fleet --spec /path/to/fleet-setup.json --approve
```

The JSON spec names the folder, verified backup witness, local or SSH hub, authority root/state/config, and each target root/state/config/request path. Interactive and scriptable setup create target-local keys, enroll and project the final signed adoption revision, seal the source, adopt each populated target, force-verify them, and stop with services disabled. They never perform cutover. Remote machines must first have the exact build, verified SSH route, credentials, and roots made available by the external fleet ceremony.

## Enroll populated targets

Each target generates its own peer key and a signed enrollment request. No private key leaves that target state directory.

```bash
codefoldersync setup \
  --mode request \
  --accepted-config /path/to/accepted-authority-config.json \
  --root /absolute/target/Code \
  --state /absolute/target/state \
  --peer wootbook \
  --request /absolute/path/wootbook-request.json
```

The authority reviews and enrolls it:

```bash
codefoldersync setup \
  --mode enroll \
  --config /authority/Code/.codefoldersync/config.json \
  --request /path/wootbook-request.json
```

Project the resulting accepted revision back to the target:

```bash
codefoldersync setup \
  --mode activate \
  --accepted-config /path/to/latest-accepted-config.json \
  --state /absolute/target/state \
  --request /path/wootbook-request.json
```

Repeat enrollment for every target before sealing the source, then distribute the latest accepted revision to all peers.

## Adoption

```bash
codefoldersync adoption seal --config /authority/config.json
codefoldersync adoption plan --config /target/config.json
codefoldersync adoption apply --adoption-id <id> --config /target/config.json
codefoldersync adoption verify --config /target/config.json
```

`plan` does not mutate the target tree. `apply` revalidates the approved target digest, preserves conflicts out of root, materializes the seal, force-hashes the result, verifies Git boundaries, and records the target as verified.

After every enrolled target verifies, cutover requires an explicit approval flag:

```bash
codefoldersync adoption cutover --approve --config /authority/config.json
```

The signed barrier advances the hub to normal mode. It does not start services. Project the new accepted revision to every target and start services one at a time only after the intended operational approval.

## Normal operation

```bash
codefoldersync doctor
codefoldersync status
codefoldersync sync
codefoldersync verify --full
codefoldersync config status
codefoldersync catalog status
codefoldersync conflicts
codefoldersync history
```

The catalog is derived. V3 has no repository or folder membership mutation commands.

Services install disabled unless `--activate` is explicitly supplied, and cannot start before cutover:

```bash
codefoldersync service install
codefoldersync service start
codefoldersync service status
codefoldersync service logs
```

Recover retained adoption evidence to an absent path without deleting the retained original:

```bash
codefoldersync recover <conflict-id> --to /absolute/absent/path
```

## Ignore contract

The authority-controlled root file uses deterministic Git-ignore-style rules with anchoring, directory rules, `**`, comments, blank lines, and negation. The generated minimum is:

```gitignore
/.codefoldersync/
/.workspace-sync/
**/node_modules/
```

V3 does not reuse `.gitignore`. A target whose ignore digest differs from the accepted configuration fails closed.

On the authority, preserve the previously accepted ignore file, edit the live file, preview its path/byte delta, then approve a signed revision:

```bash
codefoldersync config update-ignore --previous-ignore /path/to/previous.ignore
codefoldersync config update-ignore --previous-ignore /path/to/previous.ignore --approve
```

Project the accepted revision and exact ignore file to every peer before synchronization resumes.

## Verification

```bash
pnpm check
pnpm build
```

The focused V3 integration suite uses fresh temporary roots. It covers two populated target adoptions, recovery evidence, exact source immutability, source-seal/adoption/normal-apply/cutover interruption recovery, physical and contained-indirection Git convergence, signed cutover, atomic snapshot/conflict publication, recursive normal synchronization, immutable directory conflicts, rename cycles, keep-both conflicts, metadata-only directory moves, corrupt-object rejection, reserved and ignored paths, configuration/ignore tamper rejection, portable-name collisions, special filesystem objects, and external Git-dir rejection. It never targets a daily-driver Code folder or service.
