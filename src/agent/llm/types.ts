import type { ProviderToolSpec } from "@/agent/tools/registry";

/**
 * Provider-neutral LLM contract. The agent loop depends ONLY on these types.
 * src/agent/llm/openrouter.ts implements it over the OpenAI-compatible chat completions API.
 */

export type LlmContentPart = { type: "text"; text: string } | { type: "image_url"; url: string };

export type LlmToolCall = { id: string; name: string; arguments: string };

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | LlmContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type LlmRequest = {
  model: string;
  messages: LlmMessage[];
  tools: ProviderToolSpec[];
  toolChoice?: "auto" | "none";
  parallelToolCalls?: boolean;
  maxTokens?: number;
  signal: AbortSignal;
  /** Correlation for provider logs/headers */
  metadata?: { runId: string; chatId: string };
};

export type LlmEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; model: string; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" | "error"; model: string | null; toolCalls: LlmToolCall[] };

export interface LlmProvider {
  readonly id: "openrouter";
  /**
   * Stream one completion. Must:
   *  - map HTTP 429 -> AppError(provider_rate_limited, retryable)  (bounded retries live in the loop)
   *  - map 5xx / network -> AppError(provider_unavailable, retryable)
   *  - map an empty stream (no text, no tool calls) -> AppError(empty_response, retryable)
   *  - never fall back to a paid model; the model id is fixed at the boundary
   *  - report the actual routed model in the `finish`/`usage` events
   */
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}
