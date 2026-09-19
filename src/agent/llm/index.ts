import type { LlmProvider } from "./types";

/** OpenRouter provider factory (agent-engine slice): createLlmProvider() -> OpenRouterProvider over OPENROUTER_BASE_URL with model OPENROUTER_MODEL. */
export function createLlmProvider(): LlmProvider {
  throw new Error("LLM provider not implemented");
}
