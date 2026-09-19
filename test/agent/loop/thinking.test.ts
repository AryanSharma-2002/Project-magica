import { describe, expect, it } from "vitest";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import type { LlmEvent } from "@/agent/llm/types";
import type { ThinkingBlock } from "@agent-chat/contracts";

describe("runAgentTurn: thinking deltas", () => {
  it("produces a thinking block with durationMs and reports thinkingMs via metadata", async () => {
    const run = makeRunRecord();
    let tick = 0;
    const now = () => new Date((tick++) * 100);

    const events: LlmEvent[] = [
      { type: "thinking_delta", delta: "Let me consider " },
      { type: "thinking_delta", delta: "this carefully." },
      { type: "text_delta", delta: "Here is the answer." },
      { type: "usage", model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      { type: "finish", reason: "stop", model: "m", toolCalls: [] },
    ];
    const llm = new ScriptedLlm([events]);
    const { deps, realtime, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, now });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");

    // thinking block at index 0, text block at index 1.
    expect(realtime.textFor(0)).toBe("Let me consider this carefully.");
    expect(realtime.textFor(1)).toBe("Here is the answer.");

    const thinkingStarted = realtime.metadataPatches.find((p) => p.step === "Thinking");
    expect(thinkingStarted?.thinkingStartedAt).toBeTruthy();

    const thinkingEnded = realtime.metadataPatches.find((p) => p.thinkingMs !== undefined && p.thinkingMs !== null);
    expect(thinkingEnded).toBeTruthy();
    expect(thinkingEnded?.step).toBeNull();
    expect(thinkingEnded?.thinkingMs).toBeGreaterThan(0);

    const finalized = store.finalizeCalls[0]!.input;
    const thinkingBlock = finalized.blocks[0] as ThinkingBlock;
    expect(thinkingBlock.type).toBe("thinking");
    expect(thinkingBlock.text).toBe("Let me consider this carefully.");
    expect(thinkingBlock.durationMs).toBe(thinkingEnded?.thinkingMs);
  });
});
