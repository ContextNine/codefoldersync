# CodeFolderSync V3 installation and services

## Requirements

- Node.js 22 or newer and pinned pnpm;
- Git;
- local filesystem access to the selected root and same-filesystem state;
- noninteractive SSH access when the hub is remote;
- the same exact CodeFolderSync 0.3.0 build on every peer and hub.

No account or hosted CodeFolderSync service exists.

## Versioned install

```bash
corepack pnpm install
pnpm check
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync --version
```

The installer copies `dist/` to `~/.local/lib/codefoldersync/0.3.0/` and atomically activates `~/.local/bin/codefoldersync`. Rollback only changes the wrapper to a retained version; it does not convert V3 config, state, or hub data.

## Setup sequence

V3 setup is an explicit signed exchange:

1. Authority creates a fresh folder and hub with a verified backup witness.
2. Each target generates its own key and enrollment request.
3. Authority enrolls reviewed requests, advancing config revision each time.
4. The latest accepted revision is projected read-only to every peer.
5. Authority seals once.
6. Each populated target plans, applies, and verifies.
7. Authority approves the one-way cutover.
8. The normal revision is projected everywhere before services start.

The exact flags are documented in the CodeFolderSync README and `codefoldersync help`.

`codefoldersync setup` is the interactive form for a controller with access to the authority and populated target roots. It prompts for the folder, hub, backup witness, authority, targets, state/config/request paths, and final source-authoritative adoption approval. `codefoldersync setup --mode fleet --spec <json> --approve` is its exact scriptable equivalent. Both perform enrollment, final projection, source seal, target plan/apply/verification, and return cutover readiness while leaving every service disabled. They require an explicit backup witness and approval and do not sign the cutover barrier.

The repository controller can operate only on roots visible to its process. Real multi-machine use still requires the separately verified topology, exact build, SSH, credentials, backups, and per-machine execution described by the operational acceptance plan.

## Filesystem probe

Setup verifies atomic rename, exact symlink creation, case and Unicode behavior, and same-device root/state placement. A failed capability prevents configuration activation.

## launchd and systemd

One service is generated per folder ID:

- launchd: `dev.codefoldersync.<folder-id>`;
- systemd user unit: `codefoldersync-<folder-id>.service`.

```bash
codefoldersync service install
codefoldersync service status
codefoldersync service logs
```

Install is disabled by default. `service start` and `service restart` reject adoption-mode configuration. Service activation during daily-driver adoption requires the separate cutover approval and staged peer-by-peer start.

Uninstall archives the exact definition under recovery. It does not delete the root, state, objects, conflicts, recovery, config, keys, or hub.

## V2 replacement

V3 does not migrate V2 in place or expose V2 repository membership, ignore push/pull, empty join, or V1 migration commands. Preserve old config, state, hubs, services, evidence, and installed versions until V3 external acceptance and a separately approved cleanup.
