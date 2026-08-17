import Link from "next/link";

export function SiteHeader({ docs = false }: { docs?: boolean }) {
  return (
    <header className="site-header">
      <div className="nav-shell">
        <Link className="brand" href="/">
          <span>CTX9</span>
          <span className="brand-product">Code Folder Sync</span>
        </Link>
        <nav aria-label="Primary navigation">
          {docs ? (
            <Link href="/">Overview</Link>
          ) : (
            <>
              <a href="#why">Why</a>
              <a href="#how-it-works">How it works</a>
            </>
          )}
          <Link aria-current={docs ? "page" : undefined} href="/docs">
            Documentation
          </Link>
          <a href="https://github.com/MDerman/codefoldersync">Source</a>
        </nav>
      </div>
    </header>
  );
}
