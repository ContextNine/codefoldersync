"use client";

import Link from "next/link";
import { useState } from "react";
import { BouncyDivider } from "./bouncy-divider";
import { ContextNineWordmark } from "./context-nine-wordmark";

export function SiteHeader({ docs = false }: { docs?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="nav-shell">
        <Link className="brand" href="/">
          <ContextNineWordmark />
          <span className="brand-product">/ Code Folder Sync</span>
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
        <button
          className="menu-button"
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
        </button>
      </div>
      <nav
        className={`mobile-nav ${menuOpen ? "mobile-nav-open" : ""}`}
        aria-label="Mobile navigation"
      >
        <Link href="/" onClick={() => setMenuOpen(false)}>
          Overview
        </Link>
        <Link href="/docs" onClick={() => setMenuOpen(false)}>
          Documentation
        </Link>
        <a href="https://github.com/MDerman/codefoldersync">
          Source <span aria-hidden="true">↗</span>
        </a>
      </nav>
      <BouncyDivider />
    </header>
  );
}
