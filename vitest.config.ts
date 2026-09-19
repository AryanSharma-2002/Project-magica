import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "packages/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: { provider: "v8", include: ["src/**", "packages/contracts/src/**"], exclude: ["src/generated/**"] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@agent-chat/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
    },
  },
});
