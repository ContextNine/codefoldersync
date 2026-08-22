import type { ReactNode } from "react";
import { CodeBlock } from "../components/code-block";
import { SiteLink } from "../components/site-link";

export interface DocSection {
  id: string;
  label: string;
}

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  sections: readonly DocSection[];
  body: ReactNode;
}

export const docsNavigation = [
  {
    label: "Start",
    items: [
      { href: "/docs", label: "Introduction", slug: "" },
      {
        href: "/docs/installation",
        label: "Installation",
        slug: "installation",
      },
      {
        href: "/docs/getting-started",
        label: "Getting started",
        slug: "getting-started",
      },
    ],
  },
  {
    label: "Understand",
    items: [
      {
        href: "/docs/how-it-works",
        label: "How sync works",
        slug: "how-it-works",
      },
      {
        href: "/docs/conflicts-and-recovery",
        label: "Conflicts and recovery",
        slug: "conflicts-and-recovery",
      },
      {
        href: "/docs/safety-and-backups",
        label: "Safety and backups",
        slug: "safety-and-backups",
      },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/docs/operations", label: "Operations", slug: "operations" },
      {
        href: "/docs/cli-reference",
        label: "CLI reference",
        slug: "cli-reference",
      },
      {
        href: "/docs/troubleshooting",
        label: "Troubleshooting",
        slug: "troubleshooting",
      },
    ],
  },
] as const;

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="callout">
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

function CommandRows({
  rows,
}: {
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <div className="command-rows">
      {rows.map(([command, description]) => (
        <div key={command}>
          <code>{command}</code>
          <span>{description}</span>
        </div>
      ))}
    </div>
  );
}

export const docs: readonly DocPage[] = [
  {
    slug: "",
    title: "Code Folder Sync documentation",
    description:
      "Install, configure, understand, and safely operate a self-hosted folder sync across trusted machines.",
    sections: [
      { id: "in-five-minutes", label: "In five minutes" },
      { id: "guides", label: "Guides" },
      { id: "scope", label: "Supported scope" },
    ],
    body: (
      <>
        <p>
          Code Folder Sync recursively keeps one complete code root synchronized
          across your machines. It discovers ordinary files, directories,
          symlinks, and nested Git boundaries automatically, while treating each
          Git state as one validated, recoverable transaction.
        </p>
        <Callout title="No hosted service">
          <p>
            There is no account or browser flow. Peers connect to a local or SSH
            hub directory on a machine you control. Hub content is plaintext.
          </p>
        </Callout>

        <h2 id="in-five-minutes">In five minutes</h2>
        <CodeBlock label="Build and install">{`corepack pnpm install
pnpm check
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync setup`}</CodeBlock>
        <p>
          The setup flow creates one configuration authority, enrolls signed
          peer requests, and guides source-authoritative adoption. Services stay
          disabled until all targets verify and the authority approves cutover.
          Start with <SiteLink href="/docs/installation">Installation</SiteLink>{" "}
          for requirements or go directly to{" "}
          <SiteLink href="/docs/getting-started">Getting started</SiteLink>.
        </p>

        <h2 id="guides">Guides</h2>
        <div className="guide-rows">
          {docsNavigation
            .flatMap((group) => group.items)
            .slice(1)
            .map((item) => (
              <SiteLink href={item.href} key={item.href}>
                <span>{item.label}</span>
                <span aria-hidden="true">→</span>
              </SiteLink>
            ))}
        </div>

        <h2 id="scope">Supported scope</h2>
        <p>
          Version 3 synchronizes the recursively included namespace below one
          root. Nested physical Git repositories and contained Git indirection
          are supported. Reserved state, ignored paths, mount crossings,
          sockets, devices, FIFOs, unsafe aliases, and Git directories outside
          the root are rejected.
        </p>
      </>
    ),
  },
  {
    slug: "installation",
    title: "Installation",
    description:
      "Build and activate the same version on every peer and on the SSH hub host.",
    sections: [
      { id: "requirements", label: "Requirements" },
      { id: "build-and-install", label: "Build and install" },
      { id: "versions", label: "Versions and rollback" },
      { id: "services", label: "Service support" },
    ],
    body: (
      <>
        <p>
          Code Folder Sync is currently installed from a trusted checkout. The
          installer copies a versioned build and activates a small wrapper in
          your user-local bin directory.
        </p>

        <h2 id="requirements">Requirements</h2>
        <ul>
          <li>Linux x86-64 or macOS arm64.</li>
          <li>Node.js 22 or newer.</li>
          <li>Git.</li>
          <li>SSH key access when the hub is on another machine.</li>
          <li>A backup witness before source sealing or target mutation.</li>
        </ul>
        <p>
          No root access, account, signup, token, or browser callback is
          required.
        </p>

        <h2 id="build-and-install">Build and install</h2>
        <CodeBlock>{`git clone https://github.com/MDerman/codefoldersync.git
cd codefoldersync
corepack pnpm install
pnpm check
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync --version`}</CodeBlock>
        <p>
          Install the same build on the hub machine before configuring an SSH
          hub. The remote command defaults to{" "}
          <code>~/.local/bin/codefoldersync</code>.
        </p>

        <h2 id="versions">Versions and rollback</h2>
        <p>
          Each build is stored under{" "}
          <code>~/.local/lib/codefoldersync/&lt;version&gt;/</code>. Activation
          changes atomically, and an existing version is never overwritten in
          place.
        </p>
        <CodeBlock>{`codefoldersync upgrade
codefoldersync rollback --version 0.3.0`}</CodeBlock>

        <h2 id="services">Service support</h2>
        <p>
          After signed cutover, setup can create one user service per folder: a
          launchd label on macOS or a systemd user unit on Linux. Installation,
          start, and restart fail closed while the folder remains in adoption.
        </p>
        <CommandRows
          rows={[
            [
              "codefoldersync service install",
              "Generate and activate the per-folder service.",
            ],
            [
              "codefoldersync service status",
              "Inspect the exact configured service.",
            ],
            ["codefoldersync service logs", "Print the service log locations."],
            [
              "codefoldersync service uninstall",
              "Remove only the service, never synchronized data.",
            ],
          ]}
        />
      </>
    ),
  },
  {
    slug: "getting-started",
    title: "Getting started",
    description:
      "Create the authority, enroll populated peers, and adopt them without mutating the source.",
    sections: [
      { id: "before-you-start", label: "Before you start" },
      { id: "create", label: "Create the authority" },
      { id: "join", label: "Enroll another machine" },
      { id: "verify", label: "Adopt and cut over" },
    ],
    body: (
      <>
        <p>
          The interactive authority wizard is the shortest path for the source.
          Target key generation, enrollment approval, adoption, verification,
          and cutover remain explicit so no populated tree is silently chosen as
          the winner.
        </p>

        <h2 id="before-you-start">Before you start</h2>
        <ul>
          <li>Choose the complete source code root.</li>
          <li>
            Choose a local hub path or an SSH hub path on a trusted machine.
          </li>
          <li>Keep hub and peer state outside the synchronized root.</li>
          <li>Create and verify a recoverable backup witness.</li>
          <li>
            Install the same Code Folder Sync version on every participating
            machine.
          </li>
        </ul>
        <Callout title="The hub holds plaintext">
          <p>
            Protect the hub with filesystem permissions, disk encryption, and
            backups appropriate for source code. SSH encrypts transport only.
          </p>
        </Callout>

        <h2 id="create">Create the authority</h2>
        <CodeBlock>{`codefoldersync setup --mode authority \\
  --root /absolute/path/to/code \\
  --hub ssh://user@hub-host/absolute/path/to/hub \\
  --backup-witness <verified-witness-id>`}</CodeBlock>
        <p>
          The authority owns configuration revisions and the final cutover
          approval. Seal its recursive source snapshot before preparing any
          target.
        </p>
        <CodeBlock>{`codefoldersync adoption seal`}</CodeBlock>

        <h2 id="join">Enroll another machine</h2>
        <p>
          A populated target creates its own key and signed enrollment request.
          The authority approves that request, and the target activates only the
          accepted signed projection. Private peer keys never move between
          machines.
        </p>
        <CodeBlock>{`codefoldersync setup \\
  --mode request \\
  --accepted-config /path/to/accepted-config.json \\
  --root /absolute/path/to/code \\
  --state /absolute/path/to/state \\
  --request /path/to/request.json

codefoldersync setup --mode enroll \\
  --config /path/to/authority-config.json \\
  --request /path/to/request.json

codefoldersync setup --mode activate \\
  --accepted-config /path/to/accepted-config.json \\
  --state /absolute/path/to/state \\
  --request /path/to/request.json`}</CodeBlock>

        <h2 id="verify">Adopt and cut over</h2>
        <CodeBlock>{`codefoldersync adoption plan
codefoldersync adoption apply --adoption-id <id>
codefoldersync adoption verify

# On the authority, only after every target verifies:
codefoldersync adoption cutover --approve
codefoldersync service install
codefoldersync service start`}</CodeBlock>
        <p>
          Adoption keeps the sealed source authoritative, writes displaced
          target content to recovery, and requires a forced content
          verification. Multi-writer synchronization and services remain blocked
          until the signed cutover barrier is accepted.
        </p>
      </>
    ),
  },
  {
    slug: "how-it-works",
    title: "How sync works",
    description:
      "A plain-language path from one saved file to a causally accepted change on every peer.",
    sections: [
      { id: "one-folder", label: "One recursive folder" },
      { id: "save-path", label: "The saved-file path" },
      { id: "content", label: "Immutable content" },
      { id: "ordering", label: "Causal ordering" },
      { id: "git", label: "The Git plane" },
      { id: "reconciliation", label: "Reconciliation" },
    ],
    body: (
      <>
        <p>
          Code Folder Sync separates file identity, placement, and content. A
          rename can move one stable node without re-uploading its descendants,
          and a content edit can advance without turning into a path guess.
        </p>

        <h2 id="one-folder">One recursive folder</h2>
        <p>
          A folder is one recursively discovered synchronization namespace.
          Signed authority configuration fixes the source root, peer roots, hub,
          lifecycle, and ignore digest. Every peer projects the same accepted
          contract before sync proceeds.
        </p>

        <h2 id="save-path">The saved-file path</h2>
        <ol>
          <li>A watcher or periodic reconciliation detects a changed path.</li>
          <li>
            The peer uses <code>lstat</code> and captures the affected leaf or
            Git boundary.
          </li>
          <li>
            Immutable objects and one causal event enter the durable outbox.
          </li>
          <li>
            New chunks and the event travel in one bounded publish exchange.
          </li>
          <li>
            The hub commits objects, accepts the event, and assigns global
            order.
          </li>
          <li>
            Other peers fetch missing objects, recheck local state, and apply.
          </li>
        </ol>

        <h2 id="content">Immutable content</h2>
        <p>
          Every object ID is the SHA-256 digest of its exact bytes. Small files
          use one chunk. Larger files use streaming content-defined chunks
          between 256 KiB and 4 MiB, with a target near 1 MiB. Localized edits
          usually reuse accepted chunks before and after the change.
        </p>
        <p>
          Symlink manifests contain only the exact target string. Capture and
          apply never follow the link.
        </p>

        <h2 id="ordering">Causal ordering</h2>
        <p>
          Each mutation carries the entry and content versions it observed. The
          hub compares those bases in one SQLite transaction and assigns the
          canonical sequence. Wall clocks never choose a winner. Lost
          acknowledgements retry the exact event ID and peer sequence
          idempotently.
        </p>

        <h2 id="git">The Git plane</h2>
        <p>
          Nested Git boundaries are discovered automatically. A stable Git
          directory is captured as a content-addressed tree, checked with
          <code>git fsck --full</code>, transferred incrementally, staged on the
          destination, checked again, and swapped under a recovery journal.
        </p>

        <h2 id="reconciliation">Reconciliation</h2>
        <p>
          Watchers improve latency but are not trusted as an event log. Startup,
          structural changes, overflow, ambiguity, and the periodic deadline
          trigger a full metadata walk and checkpoint reconciliation. Unchanged
          file observations reuse accepted manifests; full verification
          intentionally rehashes content.
        </p>
      </>
    ),
  },
  {
    slug: "conflicts-and-recovery",
    title: "Conflicts and recovery",
    description:
      "Understand keep-both file conflicts, transactional Git conflicts, and isolated recovery exports.",
    sections: [
      { id: "ordinary", label: "Ordinary conflicts" },
      { id: "resolve-files", label: "Resolve file conflicts" },
      { id: "git-conflicts", label: "Git conflicts" },
      { id: "recover", label: "Recover a manifest" },
      { id: "crash-recovery", label: "Crash recovery" },
    ],
    body: (
      <>
        <p>
          Code Folder Sync never merges lines. If two stable versions cannot
          both occupy the same canonical state, it keeps both complete byte
          sequences and records the causal evidence.
        </p>

        <h2 id="ordinary">Ordinary conflicts</h2>
        <p>
          If <code>alpha</code> and <code>beta</code> both save
          <code>settings.json</code> from the same base and alpha reaches the
          hub first, every peer converges to two files:
        </p>
        <CodeBlock label="Filesystem">{`settings.json
settings.CODEFOLDERSYNC-CONFLICT.beta.8c12f09d.json`}</CodeBlock>
        <p>
          The original contains alpha&apos;s exact bytes. The sibling contains
          beta&apos;s exact bytes. Executable meaning and symlink target text
          follow the competing version.
        </p>

        <h2 id="resolve-files">Resolve file conflicts</h2>
        <CodeBlock>{`codefoldersync conflicts
codefoldersync history
rg --files /path/to/code | rg 'CODEFOLDERSYNC-CONFLICT'`}</CodeBlock>
        <p>
          Inspect both files, create the intended result, then delete or rename
          the extra sibling with normal filesystem or Git tools. Those changes
          sync like any other save. Do not delete hub objects or recovery
          directories to make a conflict disappear.
        </p>

        <h2 id="git-conflicts">Git conflicts</h2>
        <p>
          Concurrent valid <code>.git</code> states become explicit conflict
          manifests, not a directory of independently merged refs and indexes.
          Inspect retained history and materialize either manifest to an
          unrelated path before choosing deliberately.
        </p>
        <CodeBlock>{`codefoldersync conflicts
codefoldersync history
codefoldersync recover <conflict-id> --to /absolute/empty/path`}</CodeBlock>

        <h2 id="recover">Recover a manifest</h2>
        <p>
          Materialize retained content to an unrelated empty destination without
          changing the synchronized folder:
        </p>
        <CodeBlock>{`codefoldersync recover <manifest-or-conflict-id> \\
  --to /absolute/empty/path`}</CodeBlock>

        <h2 id="crash-recovery">Crash recovery</h2>
        <p>
          Replacements, deletes, renames, and Git swaps use durable journals and
          recovery locations. Startup restores the last local baseline before
          normal hub reconciliation. Recovery data is retained by default and is
          a separate crash-safety layer from synchronized conflict siblings.
        </p>
      </>
    ),
  },
  {
    slug: "operations",
    title: "Operations",
    description:
      "Run routine checks, manage the daemon, revise the recursive folder contract, and respond to incidents.",
    sections: [
      { id: "routine", label: "Routine checks" },
      { id: "status", label: "Status meanings" },
      { id: "single-writer", label: "Single writer" },
      { id: "membership", label: "Catalog and ignores" },
      { id: "incident", label: "Incident response" },
    ],
    body: (
      <>
        <p>
          The background daemon is the normal writer. Read-only status and
          history remain available while it runs; deliberate mutating
          maintenance requires an explicit service handoff.
        </p>

        <h2 id="routine">Routine checks</h2>
        <CommandRows
          rows={[
            [
              "codefoldersync doctor",
              "Validate configuration and hub reachability.",
            ],
            [
              "codefoldersync status",
              "Read cursor, outbox, and conflict state without hashing files.",
            ],
            [
              "codefoldersync sync",
              "Perform an intentional foreground reconciliation.",
            ],
            [
              "codefoldersync verify --full",
              "Rehash the complete tree and verify accepted state.",
            ],
            [
              "codefoldersync service status",
              "Inspect the folder-qualified daemon.",
            ],
            [
              "codefoldersync service logs",
              "Print exact service log locations.",
            ],
          ]}
        />

        <h2 id="status">Status meanings</h2>
        <div className="definition-rows">
          <div>
            <code>clean</code>
            <p>
              The local cursor matches accepted hub state and no live conflict
              exists.
            </p>
          </div>
          <div>
            <code>conflict</code>
            <p>
              Sync completed and preserved every version, but at least one
              conflict remains unresolved.
            </p>
          </div>
          <div>
            <code>offline</code>
            <p>
              The hub could not be reached. Local objects and events remain
              queued.
            </p>
          </div>
          <div>
            <code>inconclusive</code>
            <p>
              A filesystem, object, Git, protocol, scan, or apply invariant
              could not be proven.
            </p>
          </div>
        </div>
        <p>Offline and inconclusive are never convergence success.</p>

        <h2 id="single-writer">Single writer</h2>
        <p>
          The daemon holds an owner-only lock for its lifetime. Mutating
          foreground commands fail closed while it is active. Stop the service
          before a manual sync, full verification, or approved ignore change,
          then start it again afterward.
        </p>
        <CodeBlock>{`codefoldersync service stop
codefoldersync verify --full
codefoldersync service start`}</CodeBlock>

        <h2 id="membership">Catalog and ignores</h2>
        <CodeBlock>{`codefoldersync catalog status
codefoldersync config status
codefoldersync config update-ignore \\
  --previous-ignore /path/to/previous-ignore \\
  --approve`}</CodeBlock>
        <p>
          The catalog is derived recursively and has no manual membership list.
          Only the authority can accept a new ignore revision after previewing
          the included and excluded entry and byte counts. Peers project the
          accepted signed revision.
        </p>

        <h2 id="incident">Incident response</h2>
        <ol>
          <li>
            Stop automated writers for apply, corruption, disk, or unsafe-path
            failures.
          </li>
          <li>
            Leave the workspace, outbox, object stores, hub, staging, and
            recovery intact.
          </li>
          <li>
            Capture doctor, status, service logs, free space, and read-only Git
            diagnostics.
          </li>
          <li>Restore connectivity or storage capacity before retrying.</li>
          <li>
            Run normal sync, then <code>verify --full</code> and{" "}
            <code>git fsck --full</code>.
          </li>
        </ol>
      </>
    ),
  },
  {
    slug: "safety-and-backups",
    title: "Safety and backups",
    description:
      "Know what Code Folder Sync preserves, what the hub can see, and what a complete backup contains.",
    sections: [
      { id: "trust", label: "Trust model" },
      { id: "filesystem", label: "Filesystem boundary" },
      { id: "durability", label: "Durability" },
      { id: "retention", label: "Retention" },
      { id: "backup", label: "Backup and restore" },
    ],
    body: (
      <>
        <p>
          Code Folder Sync is designed for a small trusted fleet. It preserves
          observed stable versions and fails closed when the evidence required
          for safe capture, ordering, or apply is unavailable.
        </p>

        <h2 id="trust">Trust model</h2>
        <Callout title="The hub can read synchronized content">
          <p>
            SSH authenticates peers and encrypts transport. Objects and metadata
            are plaintext in the hub directory and inherit that host&apos;s
            filesystem permissions, disk encryption, monitoring, and backup
            policy. The hub verifies enrolled peer signatures and the signed
            authority configuration before accepting changes.
          </p>
        </Callout>
        <p>
          There is no multi-user authorization layer, hosted API, or
          peer-to-peer leader election. The authority is the sole configuration
          writer; peers are target-local identities.
        </p>

        <h2 id="filesystem">Filesystem boundary</h2>
        <ul>
          <li>The configured root cannot be a symlink.</li>
          <li>
            Every apply path is normalized, contained, and checked through real
            directory ancestors.
          </li>
          <li>
            Capture uses <code>lstat</code>; symlink target text is stored
            without dereferencing.
          </li>
          <li>
            Sockets, devices, FIFOs, unsafe aliases, and external Git-directory
            indirection stop affected work.
          </li>
          <li>
            Bytes, directory structure, executable meaning, and symlink targets
            are portable.
          </li>
        </ul>
        <p>
          Ownership, ACLs, extended attributes, non-executable permission bits,
          timestamps, sparse allocation, flags, and hardlink topology are not
          preserved.
        </p>

        <h2 id="durability">Durability</h2>
        <p>
          Local and hub SQLite stores use WAL and full synchronous commits.
          Objects commit before any event can expose them. Local mutations enter
          a durable outbox before network I/O. Remote replacements move existing
          content to recovery and use journaled atomic rename instead of
          unlinking the only live bytes first.
        </p>

        <h2 id="retention">Retention</h2>
        <p>
          Current state, accepted event history, conflicts, recovery data, and
          their immutable objects are retained. Garbage collection is
          report-only:
        </p>
        <CodeBlock>{`codefoldersync gc --dry-run`}</CodeBlock>
        <p>Automatic deletion is disabled.</p>

        <h2 id="backup">Backup and restore</h2>
        <p>A complete backup includes all four parts:</p>
        <ol>
          <li>The synchronized root.</li>
          <li>The complete peer state directory.</li>
          <li>The owner-only folder configuration.</li>
          <li>
            The whole hub directory, including both SQLite stores and a
            consistent view of WAL state.
          </li>
        </ol>
        <p>
          Stop hub writers or use a storage-level consistent snapshot. After a
          restore, keep normal writers stopped and run <code>doctor</code>,
          <code>status</code>, <code>verify --full</code>, and
          <code>git fsck --full</code> before resuming the daemon.
        </p>
      </>
    ),
  },
  {
    slug: "cli-reference",
    title: "CLI reference",
    description:
      "A concise command map for installation, setup, synchronization, inspection, and recovery.",
    sections: [
      { id: "install", label: "Install and activate" },
      { id: "setup", label: "Setup" },
      { id: "sync", label: "Sync and inspect" },
      { id: "service", label: "Service" },
      { id: "folder", label: "Adoption and contract" },
      { id: "recovery", label: "Conflict and recovery" },
    ],
    body: (
      <>
        <p>
          Commands use the default config at
          <code>~/Code/.codefoldersync/config.json</code> unless
          <code>--config &lt;path&gt;</code> is supplied.
        </p>

        <h2 id="install">Install and activate</h2>
        <CommandRows
          rows={[
            ["codefoldersync install", "Install the current built version."],
            [
              "codefoldersync upgrade",
              "Install and activate another built version.",
            ],
            [
              "codefoldersync rollback --version <version>",
              "Activate a retained version.",
            ],
          ]}
        />

        <h2 id="setup">Setup</h2>
        <CommandRows
          rows={[
            ["codefoldersync setup", "Run the interactive authority wizard."],
            [
              "codefoldersync setup --mode authority ...",
              "Create the signed authority configuration.",
            ],
            [
              "codefoldersync setup --mode request ...",
              "Create a target-local key and enrollment request.",
            ],
            [
              "codefoldersync setup --mode enroll ...",
              "Approve a target request on the authority.",
            ],
            [
              "codefoldersync setup --mode activate ...",
              "Activate an accepted projection on the target.",
            ],
          ]}
        />

        <h2 id="sync">Sync and inspect</h2>
        <CommandRows
          rows={[
            [
              "codefoldersync doctor",
              "Validate configuration and hub reachability.",
            ],
            [
              "codefoldersync status",
              "Read cursor, outbox, and conflict state.",
            ],
            ["codefoldersync sync", "Run one foreground synchronization."],
            ["codefoldersync daemon", "Run the persistent foreground daemon."],
            [
              "codefoldersync verify --full",
              "Force-hash and verify the complete folder.",
            ],
            ["codefoldersync history", "Read causal event and result history."],
          ]}
        />

        <h2 id="service">Service</h2>
        <CodeBlock>{`codefoldersync service install
codefoldersync service start
codefoldersync service restart
codefoldersync service stop
codefoldersync service status
codefoldersync service logs
codefoldersync service uninstall`}</CodeBlock>

        <h2 id="folder">Adoption and contract</h2>
        <CommandRows
          rows={[
            [
              "codefoldersync adoption seal",
              "Publish the authority source seal.",
            ],
            [
              "codefoldersync adoption plan",
              "Classify a populated target without mutation.",
            ],
            [
              "codefoldersync adoption apply --adoption-id <id>",
              "Recover target differences and apply the source seal.",
            ],
            [
              "codefoldersync adoption verify",
              "Force-hash and record a target verification.",
            ],
            [
              "codefoldersync adoption cutover --approve",
              "Publish the signed normal-mode barrier.",
            ],
            [
              "codefoldersync config update-ignore --previous-ignore <path> [--approve]",
              "Preview or approve an authority ignore revision.",
            ],
          ]}
        />

        <h2 id="recovery">Conflict and recovery</h2>
        <CommandRows
          rows={[
            ["codefoldersync conflicts", "List ordinary and Git conflicts."],
            [
              "codefoldersync recover <id> --to <empty-path>",
              "Export retained content without changing the folder.",
            ],
            [
              "codefoldersync gc --dry-run",
              "Report reachability; never delete automatically.",
            ],
          ]}
        />
      </>
    ),
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description:
      "Start with status, preserve evidence, and resolve the common non-clean states without forcing a winner.",
    sections: [
      { id: "first-checks", label: "First checks" },
      { id: "offline", label: "Offline" },
      { id: "inconclusive", label: "Inconclusive" },
      { id: "conflict", label: "Conflict" },
      { id: "writer-lock", label: "Writer lock" },
      { id: "join", label: "Adoption issues" },
    ],
    body: (
      <>
        <p>
          Do not clear a problem by deleting state, objects, hub data, staging,
          or recovery. The retained evidence is what makes safe retry and
          diagnosis possible.
        </p>

        <h2 id="first-checks">First checks</h2>
        <CodeBlock>{`codefoldersync doctor
codefoldersync status
codefoldersync service status
codefoldersync service logs`}</CodeBlock>

        <h2 id="offline">Status is offline</h2>
        <p>
          Confirm the hub path, SSH host access, remote installation, and
          available disk space. Local changes remain in the durable outbox.
          Restore connectivity and let the same events retry; do not create
          replacement events to work around an unknown network outcome.
        </p>

        <h2 id="inconclusive">Status is inconclusive</h2>
        <p>
          The peer could not prove a filesystem, object, Git, protocol, scan, or
          apply invariant. Stop writers if the cause involves corruption, disk
          capacity, or unsafe paths. Preserve both hub and peer copies, fix the
          underlying condition, then run a normal sync and full verification.
        </p>

        <h2 id="conflict">Status is conflict</h2>
        <p>
          Synchronization completed and preserved all stable versions. Find
          ordinary siblings directly or inspect Git records:
        </p>
        <CodeBlock>{`codefoldersync conflicts
codefoldersync history
find /path/to/code -name '*CODEFOLDERSYNC-CONFLICT*'`}</CodeBlock>
        <p>
          Follow{" "}
          <SiteLink href="/docs/conflicts-and-recovery">
            Conflicts and recovery
          </SiteLink>
          before choosing or combining versions.
        </p>

        <h2 id="writer-lock">A mutating command refuses to run</h2>
        <p>
          The daemon is the only allowed writer for its configured folder. Stop
          the service for deliberate foreground maintenance, run the command,
          then start the service again. A second daemon also fails closed. Stale
          locks are moved to recovery on safe startup.
        </p>

        <h2 id="join">An adoption plan is rejected</h2>
        <p>
          Confirm that the target still matches the digest classified by the
          plan, its signed config projection is current, state and root share a
          filesystem, the source seal and backup witness remain accepted, and
          every displaced object can be written to recovery. Generate a new plan
          after any target change; never edit the encrypted plan or force apply.
        </p>
      </>
    ),
  },
] as const;

export function findDoc(slug: string): DocPage | undefined {
  return docs.find((doc) => doc.slug === slug);
}
