
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlayBuddies — Play Games With Friends",
  description:
    "The ultimate multiplayer gaming platform. Log in with Google, invite your friends, and play 10+ browser games together in real-time. No downloads needed.",
  keywords: [
    "multiplayer games",
    "browser games",
    "play with friends",
    "online games",
    "party games",
  ],
  authors: [{ name: "Bilal Saeed" }],
  openGraph: {
    title: "PlayBuddies — Play Games With Friends",
    description: "The ultimate multiplayer gaming platform.",
    type: "website",
  },
};

import AuthProvider from "@/components/AuthProvider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased noise" suppressHydrationWarning>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

