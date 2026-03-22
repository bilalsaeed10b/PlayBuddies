import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "export",
  basePath: "/PlayBuddies", // Adjusted for https://bilalsaeed10b.github.io/PlayBuddies/
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [],
};

export default nextConfig;
