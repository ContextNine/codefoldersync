# CodeFolderSync V3 conflicts

V3 never performs line merge or timestamp last-writer-wins.

## Adoption conflicts

During adoption the source checkpoint is always canonical. Target-only, divergent, type-conflicting, and divergent Git paths move outside the synchronized root before source materialization. Each retained record names the original target path, recovery path, peer, reason, and recoverable manifest when one exists.

Adoption does not create conflict siblings inside the authority tree. It can therefore converge every included live target path exactly while preserving all displaced evidence.

## Normal file conflicts

If two normal peers edit `settings.json` from the same baseline, the first accepted bytes remain at the original path and the concurrent bytes become:

```text
settings.CODEFOLDERSYNC-CONFLICT.<peer>.<event>.json
```

The name uses peer identity and immutable event identity, not a clock. The sibling then synchronizes as ordinary content. Executable meaning and exact symlink target text remain in its manifest.

## Delete, move, type, and subtree races

The three-way merge compares accepted baseline, local scan, and current hub state. A remote mutation remains canonical. Losing leaf bytes receive a sibling; losing deletes remain explicit conflict evidence. Parent directories required by a preserved sibling are restored from a verified side.

Stable node IDs allow an uncontested subtree move without descendant uploads. A losing directory version receives one visible sibling plus an immutable subtree manifest containing every included descendant and nested Git boundary, so recovery does not depend on the sibling remaining live. An ambiguous concurrent structural case is never allowed to overwrite stable content; it yields explicit evidence or an inconclusive result.

Normal conflicts are signed inside the publishing snapshot and commit atomically with that checkpoint. A crash cannot accept canonical content while omitting its recovery record.

## Git conflicts

Git boundaries are complete immutable manifests. A concurrent losing Git state is recorded with its manifest rather than merged file by file. Current V3 exposes recovery evidence and does not provide the removed V2 `resolve-git` command.

## Operator workflow

```bash
codefoldersync conflicts
codefoldersync history
codefoldersync recover <conflict-id> --to /absolute/absent/path
```

`recover` copies retained recovery evidence and leaves the original intact. Resolve a visible normal sibling with ordinary filesystem and Git work, then let those explicit edits synchronize.
