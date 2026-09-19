import type { SafeError, ToolResultBlock } from "@agent-chat/contracts";

/**
 * Canonical mapping from a persisted `tool_result` block to the LLM "tool" message content.
 * Shared between the live loop (building the tool message that goes back to the model in the
 * SAME turn) and historyToLlmMessages (replaying past tool results identically on resume/reload),
 * so a retried/resumed run never sees a different tool message than the original run did.
 */
export function toolResultToLlmContent(block: ToolResultBlock): string {
  if (block.status === "completed") return JSON.stringify(block.output ?? null);
  const error: SafeError = block.error ?? { code: "internal", message: "The tool failed.", retryable: false };
  return JSON.stringify({ error });
}

/** Fallback content for a tool_use block with no recorded tool_result (a run that died mid-tool). */
export function missingToolResultContent(): string {
  return JSON.stringify({ error: { code: "internal", message: "No result was recorded for this tool call.", retryable: false } });
}
