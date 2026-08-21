import type { Metadata, Viewport } from "next";
import { Inter, Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AuthProvider from "@/components/AuthProvider";
import AppChrome from "@/components/AppChrome";

// Self-hosted at build time. The previous <link> to fonts.googleapis.com was
// render-blocking and cost two extra connections before first paint.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PlayBuddies | Play Games With Friends",
  description:
    "The ultimate multiplayer gaming platform. Log in with Google, invite your friends, and play browser games together in real-time. No downloads needed.",
  keywords: [
    "multiplayer games",
    "browser games",
    "play with friends",
    "online games",
    "party games",
  ],
  authors: [{ name: "Bilal Saeed" }],
  openGraph: {
    title: "PlayBuddies | Play Games With Friends",
    description: "The ultimate multiplayer gaming platform.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0F0F1A",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${outfit.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased noise" suppressHydrationWarning>
        <AuthProvider>
          {children}
          <AppChrome />
        </AuthProvider>
      </body>
    </html>
  );
}
