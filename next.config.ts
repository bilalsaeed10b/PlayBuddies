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
  },
};

export default nextConfig;
