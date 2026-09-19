import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agent-chat/contracts"],
  serverExternalPackages: ["pino", "@prisma/client", "@prisma/adapter-pg", "pg"],
  // The skill registry reads agent-skills/**/SKILL.md from disk at runtime; nothing imports those
  // files, so Vercel's file tracing must be told to include them.
  outputFileTracingIncludes: { "/api/**": ["./agent-skills/**/*"] },
};

export default nextConfig;
