import { ContextNineWordmark } from "./context-nine-wordmark";
import { SiteLink } from "./site-link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div>
        <SiteLink className="brand" href="/">
          <ContextNineWordmark />
          <span className="brand-product">/ Code Folder Sync</span>
        </SiteLink>
        <p>
          Open-source synchronization for trusted machines and complete Git
          worktrees.
        </p>
      </div>
      <nav aria-label="Footer navigation">
        <SiteLink href="/docs/getting-started">Getting started</SiteLink>
        <SiteLink href="/docs/cli-reference">CLI reference</SiteLink>
        <SiteLink href="/docs/safety-and-backups">Safety and backups</SiteLink>
        <a href="https://github.com/ContextNine/codefoldersync">GitHub</a>
      </nav>
    </footer>
  );
}
