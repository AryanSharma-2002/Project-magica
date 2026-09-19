import { getEnv } from "@/lib/env";
import { OpenRouterProvider } from "./openrouter";
import type { LlmProvider } from "./types";

/** OpenRouter provider factory (agent-engine slice): createLlmProvider() -> OpenRouterProvider over OPENROUTER_BASE_URL with model OPENROUTER_MODEL. */
export function createLlmProvider(): LlmProvider {
  const env = getEnv();
  const referer = process.env.OPENROUTER_HTTP_REFERER;
  const title = process.env.OPENROUTER_APP_TITLE;
  return new OpenRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    ...(referer ? { referer } : {}),
    ...(title ? { title } : {}),
  });
}
