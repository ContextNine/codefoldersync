import type { Metadata } from "next";
import { DocArticle } from "./doc-article";
import { findDoc } from "./docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Install, configure, understand, and safely operate Code Folder Sync.",
  openGraph: {
    title: "Code Folder Sync documentation",
    description:
      "Install, configure, understand, and safely operate Code Folder Sync.",
    images: [],
  },
  twitter: {
    title: "Code Folder Sync documentation",
    description:
      "Install, configure, understand, and safely operate Code Folder Sync.",
    images: [],
  },
};

export default function DocsHome() {
  const doc = findDoc("");
  if (!doc) throw new Error("documentation-home-missing");
  return <DocArticle doc={doc} />;
}
