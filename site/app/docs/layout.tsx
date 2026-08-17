import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { docsNavigation } from "./docs";

function DocsNavigation() {
  return (
    <nav className="docs-navigation" aria-label="Documentation navigation">
      {docsNavigation.map((group) => (
        <div key={group.label}>
          <span>{group.label}</span>
          {group.items.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader docs />
      <details className="mobile-docs-nav">
        <summary>Documentation menu</summary>
        <DocsNavigation />
      </details>
      <main className="docs-shell">
        <aside className="docs-sidebar">
          <DocsNavigation />
        </aside>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
