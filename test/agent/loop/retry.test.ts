import { describe, expect, it } from "vitest";
import type { TextBlock } from "@agent-chat/contracts";
import { createAgentLoop } from "@/agent/loop/index";
import { AppError } from "@/lib/errors";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

function rateLimited(): AppError {
  return new AppError("provider_rate_limited", "rate limited", { retryable: true, details: { retryAfterSeconds: 1 } });
}

describe("runAgentTurn: provider retry policy", () => {
  it("retries 429s with backoff and succeeds on the 3rd attempt", async () => {
    const run = makeRunRecord();
    const sleeps: number[] = [];
    const runAgentTurn = createAgentLoop({ sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    const llm = new ScriptedLlm([rateLimited(), rateLimited(), textTurn("Hello!")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    const finalized = store.finalizeCalls[0]!.input;
    expect((finalized.blocks[0] as TextBlock).text).toBe("Hello!");
  });

  it("fails as provider_unavailable after exhausting retries on persistent 429s, preserving earlier partial text", async () => {
    const run = makeRunRecord();
    const sleeps: number[] = [];
    const runAgentTurn = createAgentLoop({ sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    const echoTool = makeTestTool({ name: "crop_image", estimate: 10 });

    const llm = new ScriptedLlm([
      toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }], { text: "Working on it..." }),
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ]);

    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [echoTool] });
    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("provider_unavailable");
    // Turn 1 succeeded (1 call), turn 2 retried 3 times (3 calls) = 4 total provider calls.
    expect(llm.calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 2000]);

    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.blocks.some((b) => b.type === "text" && b.text === "Working on it...")).toBe(true);
    expect(finalized.blocks.some((b) => b.type === "tool_result" && b.status === "completed")).toBe(true);
  });

  it("retries an empty response up to 3 attempts and fails as empty_response", async () => {
    const run = makeRunRecord();
    const sleeps: number[] = [];
    const runAgentTurn = createAgentLoop({ sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    const empty = new AppError("empty_response", "empty", { retryable: true });
    const llm = new ScriptedLlm([empty, empty, empty]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("empty_response");
    expect(llm.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(store.finalizeCalls[0]!.input.status).toBe("failed");
  });

  it("does not retry a non-retryable provider error", async () => {
    const run = makeRunRecord();
    const sleeps: number[] = [];
    const runAgentTurn = createAgentLoop({ sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    const llm = new ScriptedLlm([new AppError("provider_error", "The free model route is unavailable right now", { retryable: false })]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("provider_error");
    expect(llm.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
