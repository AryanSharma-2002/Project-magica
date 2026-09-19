import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_placeholder",
  dirs: ["./src/trigger"],
  runtime: "node-24",
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1 },
  },
  build: {
    extensions: [
      prismaExtension({ mode: "modern" }),
      // Skills are read from disk by the registry inside the agent-turn task.
      additionalFiles({ files: ["./agent-skills/**"] }),
    ],
  },
});
