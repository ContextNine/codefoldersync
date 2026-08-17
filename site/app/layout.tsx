import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://codefoldersync.ctx9.com"),
  title: {
    default: "Code Folder Sync",
    template: "%s · Code Folder Sync",
  },
  description:
    "Self-hosted, conflict-safe synchronization for the folder containing your Git repositories.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
