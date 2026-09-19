import type { RunUsage, UsageBlock } from "@agent-chat/contracts";

export function emptyUsage(): RunUsage {
  return { model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };
}

/** Adds one LLM call's token usage to the running total and counts the call. */
export function accumulateUsage(acc: RunUsage, delta: { promptTokens: number; completionTokens: number; totalTokens: number }): RunUsage {
  return {
    model: acc.model,
    promptTokens: acc.promptTokens + delta.promptTokens,
    completionTokens: acc.completionTokens + delta.completionTokens,
    totalTokens: acc.totalTokens + delta.totalTokens,
    llmCalls: acc.llmCalls + 1,
  };
}

export function buildUsageBlock(usage: RunUsage, requestedModel: string): UsageBlock {
  return {
    type: "usage",
    model: usage.model ?? "unknown",
    requestedModel,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    microcredits: 0,
  };
}
