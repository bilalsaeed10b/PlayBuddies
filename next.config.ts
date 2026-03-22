import type { NextConfig } from "next";

const isGithubActions = process.env.GITHUB_ACTIONS || false;

const nextConfig: NextConfig = {
  /* config options here */
  output: "export",
  basePath: isGithubActions ? "/PlayBuddies" : "", // Conditional for local dev vs GitHub Pages
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [],
};

export default nextConfig;
