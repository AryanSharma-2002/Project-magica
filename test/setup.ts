import { __setEnvForTests } from "@/lib/env";

/**
 * Deterministic env for unit tests. DB integration tests use DATABASE_URL (default agent_chat_test);
 * set TEST_DATABASE_URL to point a slice at its own database.
 */
__setEnvForTests({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://localhost:5432/agent_chat_test",
  CLERK_SECRET_KEY: "sk_test_dummy",
  OPENROUTER_API_KEY: "sk-or-test",
  MAGICA_API_KEY: "magica-test",
  TRIGGER_SECRET_KEY: "tr_test_dummy",
  TRANSLOADIT_KEY: "tl-key",
  TRANSLOADIT_SECRET: "tl-secret",
  LOG_LEVEL: "error",
});
