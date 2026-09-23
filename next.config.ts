import type { NextConfig } from "next";

// The API runs as a separate Express server (see server/). The browser keeps
// calling same-origin /api/* paths, which Next.js proxies to that server.
const apiUrl = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
