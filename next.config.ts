import type { NextConfig } from "next";

const isGithubActions = process.env.GITHUB_ACTIONS || false;
const basePath = isGithubActions ? "/PlayBuddies" : "";

const nextConfig: NextConfig = {
  /* config options here */
  output: "export",
  basePath: basePath,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [],
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    // Every Pages deployment receives a new commit SHA. Games run in a
    // long-lived iframe, so stamp that SHA into its URL to prevent an older
    // cached index.html from surviving a successful release.
    NEXT_PUBLIC_BUILD_ID: process.env.GITHUB_SHA || "local",
  },
  allowedDevOrigins: [
    "192.168.100.52",
    "192.168.100.52:3000",
    "192.168.100.243",
    "192.168.100.243:3000",
    "localhost:3000",
  ],
};

export default nextConfig;
