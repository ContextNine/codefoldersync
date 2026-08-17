"use client";

import { useState } from "react";
import { BouncyDivider } from "./bouncy-divider";
import { ContextNineWordmark } from "./context-nine-wordmark";
import { SiteLink } from "./site-link";

export function SiteHeader({ docs = false }: { docs?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="nav-shell">
        <SiteLink className="brand" href="/">
          <ContextNineWordmark />
          <span className="brand-product">/ Code Folder Sync</span>
        </SiteLink>
        <nav aria-label="Primary navigation">
          {docs ? (
            <SiteLink href="/">Overview</SiteLink>
          ) : (
            <>
              <a href="#why">Why</a>
              <a href="#how-it-works">How it works</a>
            </>
          )}
          <SiteLink aria-current={docs ? "page" : undefined} href="/docs">
            Documentation
          </SiteLink>
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
        <SiteLink href="/" onClick={() => setMenuOpen(false)}>
          Overview
        </SiteLink>
        <SiteLink href="/docs" onClick={() => setMenuOpen(false)}>
          Documentation
        </SiteLink>
        <a href="https://github.com/MDerman/codefoldersync">
          Source <span aria-hidden="true">↗</span>
        </a>
      </nav>
      <BouncyDivider />
    </header>
  );
}
