import { describe, expect, it } from "vitest";
import type { ErrorBlock, UsageBlock } from "@agent-chat/contracts";
import { createAgentLoop } from "@/agent/loop/index";
import { AppError } from "@/lib/errors";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";

/**
 * Brief §11 "Diagnosability": every failed turn must be explainable from the UI alone. Seen live on
 * 2026-09-21: a run rate-limited by OpenRouter finalized FAILED with the safe error only on the
 * AgentRun row, so the assistant bubble showed "unknown · 0 tokens" and a Retry button and nothing
 * else. The finalize path now persists the safe error as an `error` block as well.
 */
describe("runAgentTurn: failed turns carry their safe error as a content block", () => {
  it("appends an error block (before the usage block) when the provider is unavailable", async () => {
    const run = makeRunRecord();
    const runAgentTurn = createAgentLoop({ sleep: async () => undefined, random: () => 0 });
    const unavailable = new AppError("provider_unavailable", "The model provider is rate limiting requests.", { retryable: true });
    const llm = new ScriptedLlm([unavailable, unavailable, unavailable]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    const blocks = store.finalizeCalls[0]!.input.blocks;
    const errorBlock = blocks.find((b): b is ErrorBlock => b.type === "error");
    expect(errorBlock?.error).toMatchObject({ code: "provider_unavailable", message: "The model provider is rate limiting requests." });
    const last = blocks[blocks.length - 1] as UsageBlock;
    expect(last.type).toBe("usage");
    expect(blocks.indexOf(errorBlock!)).toBe(blocks.length - 2);
  });

  it("adds no error block to a completed turn", async () => {
    const run = makeRunRecord();
    const runAgentTurn = createAgentLoop({ sleep: async () => undefined, random: () => 0 });
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm: new ScriptedLlm([textTurn("pong")]) });
    await runAgentTurn(run.id, deps).catch(() => undefined);
    const blocks = store.finalizeCalls[0]?.input.blocks ?? [];
    expect(blocks.some((b) => b.type === "error")).toBe(false);
  });
});
