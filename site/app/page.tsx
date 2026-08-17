import type { Metadata } from "next";
import { CodeBlock } from "./components/code-block";
import { InstallCommand } from "./components/install-command";
import { Reveal } from "./components/reveal";
import { SiteFooter } from "./components/site-footer";
import { SiteHeader } from "./components/site-header";
import { SiteLink } from "./components/site-link";

const description =
  "Keep the folder containing your Git repositories synchronized across machines you control.";

export const metadata: Metadata = {
  title: { absolute: "Code Folder Sync" },
  description,
  openGraph: {
    title: "Code Folder Sync",
    description,
    images: [{ url: "/og.png", width: 1731, height: 909 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Code Folder Sync",
    description,
    images: ["/og.png"],
  },
};

const installCommand = `corepack pnpm install
pnpm check
pnpm build
node dist/product-cli.js install
~/.local/bin/codefoldersync --version`;

const evidence = [
  ["100,000", "files joined exactly"],
  ["1.31 s", "observed p95 visibility"],
  ["10,000", "churn operations verified"],
  ["0", "silent conflict overwrites"],
] as const;

const features = [
  {
    title: "Mirrors the working tree",
    description:
      "Repositories, uncommitted work, branches, refs, indexes, symlinks, executable files, and local project state travel together.",
    detail: "Complete context",
  },
  {
    title: "Moves only changed content",
    description:
      "Content-defined chunks reuse accepted bytes. A small edit does not resend a large file or the rest of the folder.",
    detail: "Incremental transfer",
  },
  {
    title: "Keeps both versions",
    description:
      "Concurrent ordinary edits become deterministic CODEFOLDERSYNC-CONFLICT siblings. No line merge and no last-writer guess.",
    detail: "Conflict safe",
  },
  {
    title: "Treats Git as a transaction",
    description:
      "The .git directory transfers incrementally, then stages, validates, and swaps as one recoverable state.",
    detail: "Git aware",
  },
  {
    title: "Works through your SSH access",
    description:
      "A persistent framed SSH process reaches a hub directory on a machine you operate. There is no account or hosted control plane.",
    detail: "Operator controlled",
  },
  {
    title: "Queues work while offline",
    description:
      "Objects and causal events remain in a durable local outbox. Reconnect retries the same identity instead of inventing a winner.",
    detail: "Durable by default",
  },
] as const;

const faqs = [
  {
    question: "Does Code Folder Sync replace Git?",
    answer:
      "No. Git remains your history and collaboration system. Code Folder Sync mirrors the live filesystem state around it, including the complete .git directory, so another trusted machine can continue from the same working state.",
  },
  {
    question: "Is there an account or hosted service?",
    answer:
      "No. Peers use a local directory or your existing SSH access to a hub directory on a machine you control. There is no signup, browser flow, billing system, or hosted control plane.",
  },
  {
    question: "Can the hub read my files?",
    answer:
      "Yes. Hub content is plaintext and inherits that machine’s filesystem permissions, disk encryption, and backup policy. SSH authenticates the machine and encrypts transport, but Code Folder Sync does not add end-to-end encryption.",
  },
  {
    question: "What happens when two machines edit the same file?",
    answer:
      "The first causally valid event keeps the original path. Every stale competing version is preserved beside it with a deterministic CODEFOLDERSYNC-CONFLICT name that you resolve with normal tools.",
  },
  {
    question: "Can I sync any arbitrary folder?",
    answer:
      "Version 2 intentionally supports one parent folder containing explicitly enrolled direct-child Git repositories with in-tree .git directories. That narrow boundary makes membership, Git handling, path safety, and recovery provable.",
  },
  {
    question: "Which systems are supported?",
    answer:
      "The current installation contract supports Linux x86-64 and macOS arm64 with Node.js 22 or newer, Git, and SSH access when the hub is remote.",
  },
] as const;

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <a
          className="release-banner"
          href="https://github.com/MDerman/codefoldersync"
        >
          <span>Open source</span>
          <strong>
            Complete worktrees synchronized through infrastructure you control
          </strong>
          <i aria-hidden="true">↗</i>
        </a>
        <section className="hero">
          <Reveal className="hero-copy">
            <h1>Your code folder, current on every machine.</h1>
            <p>
              Synchronize complete Git worktrees through a hub you control. No
              account, hosted control plane, or silent conflict overwrite.
            </p>
            <InstallCommand />
          </Reveal>
        </section>
        <section
          className="media-section"
          aria-label="Local hub and peer overview"
        >
          <Reveal className="sync-view">
            <div className="sync-view-header">
              <span>Folder</span>
              <code>~/Code</code>
              <span className="status">clean</span>
            </div>
            <div className="peer-row">
              <span className="peer-dot" />
              <div>
                <strong>mattbook</strong>
                <span>local worktree</span>
              </div>
              <code>seq 1842</code>
            </div>
            <div className="connection-line" />
            <div className="peer-row hub-row">
              <span className="peer-dot" />
              <div>
                <strong>hub</strong>
                <span>SSH · operator controlled</span>
              </div>
              <code>durable</code>
            </div>
            <div className="connection-line" />
            <div className="peer-row">
              <span className="peer-dot" />
              <div>
                <strong>wootbook</strong>
                <span>agent worktree</span>
              </div>
              <code>seq 1842</code>
            </div>
            <div className="event-row">
              <code>src/v2/engine.ts</code>
              <span>3 chunks transferred</span>
              <span>967 ms</span>
            </div>
          </Reveal>
        </section>

        <section
          className="evidence-strip"
          aria-label="Verified fleet evidence"
        >
          {evidence.map(([value, label]) => (
            <Reveal key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </Reveal>
          ))}
        </section>

        <section className="section-shell split-heading" id="why">
          <Reveal className="split-heading-inner">
            <h2>
              Git carries history. Code Folder Sync carries work in progress.
            </h2>
            <div>
              <p>
                Commits are excellent durable checkpoints. They are awkward as a
                handoff for half-finished code, an unstaged refactor, a changed
                index, or the exact context an agent needs right now.
              </p>
              <p>
                Code Folder Sync keeps that live state aligned across a trusted
                fleet while Git continues doing the job it was built for.
              </p>
            </div>
          </Reveal>
        </section>

        <section className="feature-section" aria-label="Product capabilities">
          <Reveal className="section-heading">
            <h2>Complete working state, moved deliberately.</h2>
            <p>
              Six narrow guarantees make the whole folder dependable across a
              trusted fleet.
            </p>
          </Reveal>
          <div className="feature-grid">
            {features.map((feature, index) => (
              <Reveal
                className="feature"
                delay={(index % 3) * 0.06}
                key={feature.title}
              >
                <span className="row-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="section-shell setup-section" id="how-it-works">
          <Reveal className="section-intro">
            <h2>Build once. Create a hub. Join every other machine.</h2>
            <p>
              Install the same version on peers and the hub host, then let the
              setup wizard validate filesystem behavior before it writes any
              configuration.
            </p>
          </Reveal>
          <Reveal>
            <CodeBlock label="Build and install">{installCommand}</CodeBlock>
          </Reveal>
          <div className="steps">
            <Reveal>
              <span>01</span>
              <h3>Create the folder</h3>
              <p>
                Point setup at the parent containing your direct-child Git
                repositories and choose a local path or SSH hub.
              </p>
            </Reveal>
            <Reveal delay={0.06}>
              <span>02</span>
              <h3>Join an empty peer</h3>
              <p>
                Use the folder ID on another machine. An empty destination
                receives the exact accepted worktree and Git state.
              </p>
            </Reveal>
            <Reveal delay={0.12}>
              <span>03</span>
              <h3>Keep the daemon running</h3>
              <p>
                A per-folder user service watches stable saves, publishes
                deltas, and reconciles metadata periodically.
              </p>
            </Reveal>
          </div>
          <SiteLink className="text-action" href="/docs/getting-started">
            Follow the setup guide <span aria-hidden="true">→</span>
          </SiteLink>
        </section>

        <section className="section-shell workflow-section">
          <Reveal className="section-intro">
            <h2>One current tree for humans, remotes, and coding agents.</h2>
            <p>
              Move between machines without converting every context switch into
              a temporary commit or a hand-written file transfer.
            </p>
          </Reveal>
          <div className="workflow-grid">
            <Reveal>
              <h3>Laptop to build machine</h3>
              <p>
                Continue an uncommitted change on a faster remote host with the
                same branches, refs, index, and local project files.
              </p>
              <ul>
                <li>Direct SSH transport</li>
                <li>Chunk reuse after first join</li>
                <li>Durable offline queue</li>
              </ul>
            </Reveal>
            <Reveal delay={0.06}>
              <h3>Human to coding agent</h3>
              <p>
                Give an agent host the exact workspace you see, then receive its
                saved changes through the same causal conflict rules.
              </p>
              <ul>
                <li>No special agent integration</li>
                <li>Normal files stay normal files</li>
                <li>Competing edits remain visible</li>
              </ul>
            </Reveal>
            <Reveal delay={0.12}>
              <h3>Machine replacement</h3>
              <p>
                Join a fresh empty destination from retained hub state instead
                of reconstructing each repository and uncommitted change.
              </p>
              <ul>
                <li>Exact symlink target text</li>
                <li>Transactional Git validation</li>
                <li>Full verification command</li>
              </ul>
            </Reveal>
          </div>
        </section>

        <section className="section-shell trust-section">
          <Reveal className="section-intro">
            <h2>The safety boundary is explicit.</h2>
            <p>
              This is infrastructure for a small trusted fleet. It fails closed
              when it cannot prove that a path, object, Git state, or causal
              transition is safe.
            </p>
          </Reveal>
          <Reveal className="trust-table">
            <div>
              <span>Transport</span>
              <strong>Authenticated and encrypted by SSH</strong>
            </div>
            <div>
              <span>Hub storage</span>
              <strong>Plaintext, protected by the host and its backups</strong>
            </div>
            <div>
              <span>Conflicts</span>
              <strong>Every stable version preserved</strong>
            </div>
            <div>
              <span>Retention</span>
              <strong>Automatic object deletion disabled</strong>
            </div>
            <div>
              <span>Apply</span>
              <strong>Journaled replacement with recovery copies</strong>
            </div>
            <div>
              <span>Writer ownership</span>
              <strong>One mutating process per configured folder</strong>
            </div>
          </Reveal>
          <SiteLink className="text-action" href="/docs/safety-and-backups">
            Read the safety and backup guide <span aria-hidden="true">→</span>
          </SiteLink>
        </section>

        <section className="section-shell faq-section">
          <Reveal className="section-intro">
            <h2>Questions, answered directly.</h2>
          </Reveal>
          <div className="faq-list">
            {faqs.map((faq) => (
              <details key={faq.question}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="final-cta">
          <Reveal>
            <h2>Put every trusted machine on the same working tree.</h2>
            <p>
              Start with a local hub, understand the safety boundary, then join
              the machines where you actually work.
            </p>
            <div className="hero-actions">
              <SiteLink className="primary-action" href="/docs/installation">
                Install Code Folder Sync
              </SiteLink>
              <SiteLink href="/docs">Browse documentation</SiteLink>
            </div>
          </Reveal>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
