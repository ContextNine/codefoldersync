import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <Link className="brand" href="/">
          <span>CTX9</span>
          <span className="brand-product">Code Folder Sync</span>
        </Link>
        <p>
          Self-hosted synchronization for trusted machines and complete Git
          worktrees.
        </p>
      </div>
      <nav aria-label="Footer navigation">
        <Link href="/docs/getting-started">Getting started</Link>
        <Link href="/docs/cli-reference">CLI reference</Link>
        <Link href="/docs/safety-and-backups">Safety and backups</Link>
        <a href="https://github.com/MDerman/codefoldersync">GitHub</a>
      </nav>
    </footer>
  );
}
