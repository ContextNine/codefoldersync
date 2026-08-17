"use client";

import { useState } from "react";

const commands = [
  {
    label: "Build",
    value: "corepack pnpm install && pnpm check && pnpm build",
  },
  { label: "Install", value: "node dist/product-cli.js install" },
  { label: "Setup", value: "codefoldersync setup" },
  { label: "Status", value: "codefoldersync status" },
  { label: "Doctor", value: "codefoldersync doctor" },
] as const;

export function InstallCommand() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const command = commands[activeIndex] ?? commands[0];

  async function copy() {
    await navigator.clipboard.writeText(command.value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="install-panel">
      <div
        className="install-tabs"
        role="tablist"
        aria-label="Code Folder Sync commands"
      >
        {commands.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="tab"
            aria-selected={activeIndex === index}
            className={
              activeIndex === index ? "active-install-tab" : "install-tab"
            }
            onClick={() => {
              setActiveIndex(index);
              setCopied(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        className="install-command"
        type="button"
        onClick={() => void copy()}
      >
        <span>
          <i aria-hidden="true">$</i> {command.value}
        </span>
        <span className="copy-label">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
