import Link from "next/link";
import { ContextNineWordmark } from "./context-nine-wordmark";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <Link className="brand" href="/">
          <ContextNineWordmark />
          <span className="brand-product">/ Code Folder Sync</span>
        </Link>
        <p>
          Open-source synchronization for trusted machines and complete Git
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
