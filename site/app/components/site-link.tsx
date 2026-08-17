import type { ComponentProps } from "react";

type SiteLinkProps = ComponentProps<"a"> & { href: string };

// A full document navigation avoids vinext's client-router transition for now.
export function SiteLink({ href, children, ...props }: SiteLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
