import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agent-chat/contracts"],
  serverExternalPackages: ["pino", "@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
