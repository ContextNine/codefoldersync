# CodeFolderSync

CodeFolderSync synchronizes a parent folder of Git repositories across your machines using your existing SSH access. It has no hosted service or signup.

The safety rule is simple: different repositories may sync concurrently; one repository never gets merged file by file. If two peers change the same repository from the same baseline, CodeFolderSync stores both complete repository snapshots and blocks that repository until you choose which state becomes current.

## Install and set up

```bash
corepack pnpm install
pnpm build
pnpm link --global
codefoldersync setup
```

The setup wizard asks for the code-folder path, a local or SSH hub path, and whether this peer creates or joins the folder. Existing SSH keys authenticate the connection.

For automation, the same setup is available as flags:

```bash
codefoldersync setup \
  --mode create \
  --root /absolute/path/to/code \
  --hub ssh://user@host/absolute/path/to/hub \
  --name my-code \
  --peer laptop
```

The create result prints the folder ID. Use it to join another peer:

```bash
codefoldersync setup \
  --mode join \
  --folder-id <folder-id> \
  --root /absolute/path/to/empty/code \
  --hub ssh://user@host/absolute/path/to/hub \
  --peer desktop
```

## Routine use

```bash
codefoldersync doctor
codefoldersync status
codefoldersync sync
codefoldersync daemon --interval 2
```

The daemon stays in the foreground for systemd, launchd, or another supervisor. Every sync command processes direct-child Git repositories independently.

When a repository is blocked:

```bash
codefoldersync conflicts
codefoldersync history atlas
codefoldersync resolve atlas --take remote
# or
codefoldersync resolve atlas --take local
```

Both states remain immutable and recoverable regardless of the choice:

```bash
codefoldersync recover <snapshot-id> --to /absolute/empty/path
```

## V1 boundaries

- Linux and macOS regular files only.
- Each direct child must be a Git repository.
- A complete repository, including `.git`, is one transaction.
- Symlinks, special files, transient Git locks, path collisions, corruption, and ambiguous hub state stop sync.
- SSH protects transport. Hub snapshots are plaintext and inherit the hub host's disk permissions.
- Snapshots are full JSON bundles in v1. This favors a small correctness surface over large-repository efficiency.

## Safety harness

The repository includes a deterministic three-peer harness with exact file and Git-semantic verification, durable controller/peer journals, injected-loss rejection, repository leases, and heartbeat expiry.

```bash
pnpm check
pnpm harness doctor --config config.example.json
pnpm harness prepare --config config.example.json --run live-serial-001 --seed 91001
pnpm harness configure --config config.example.json --run live-serial-001
pnpm harness scenario serial --adapter codefoldersync --mode raw \
  --config config.example.json --run live-serial-001 --seed 91001
pnpm harness close --config config.example.json --run live-serial-001
```

`prepare` creates only a fresh sentinel-protected run root, builds the product, deploys it inside that root, and creates generated Git fixtures. `configure` creates per-run client state and an isolated hub. No user-global binary or configuration is changed.

The required scenarios are serial delayed handoff, same-repository divergence with exact recovery, and sustained parallel churn across independent repositories. The fake adapter proves the verifier rejects deliberate loss; the native live adapter proves convergence happens through CodeFolderSync rather than directory copying.

See [the current validation report](results/2026-08-16-local-validation.md).
