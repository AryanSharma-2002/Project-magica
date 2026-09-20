import { describe, expect, it } from "vitest";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";

describe("runAgentTurn: text-only turn", () => {
  it("streams text with correct indices, checkpoints, and finalizes COMPLETED with text + usage blocks", async () => {
    const run = makeRunRecord();
    const llm = new ScriptedLlm([textTurn("Hello there!", { model: "upstage/solar-pro-3:free" })]);
    const { deps, store, realtime } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(store.finalizeCalls).toHaveLength(1);
    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.status).toBe("completed");
    expect(finalized.blocks[0]).toEqual({ type: "text", text: "Hello there!" });
    expect(finalized.blocks[1]).toMatchObject({ type: "usage", model: "upstage/solar-pro-3:free", requestedModel: "openrouter/free", microcredits: 0 });
    expect(finalized.usage.llmCalls).toBe(1);
    expect(finalized.routedModel).toBe("upstage/solar-pro-3:free");

    // Realtime carried the same text at block index 0.
    expect(realtime.textFor(0)).toBe("Hello there!");
    // Status mirror: queued (initial snapshot) -> running once claimed -> completed on finalize.
    expect(realtime.statusPatches()).toEqual(["running", "completed"]);

    // Checkpointed at least once (after the LLM response).
    expect(store.checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(store.checkpoints[store.checkpoints.length - 1]).toEqual([{ type: "text", text: "Hello there!" }]);

    expect(realtime.flushCount).toBe(1);
  });

  it("never calls the skill registry beyond promptIndex when no skill tool is invoked", async () => {
    const run = makeRunRecord();
    const llm = new ScriptedLlm([textTurn("hi")]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm });
    let promptIndexCalls = 0;
    const originalPromptIndex = deps.skills.promptIndex.bind(deps.skills);
    deps.skills.promptIndex = () => {
      promptIndexCalls += 1;
      return originalPromptIndex();
    };
    deps.skills.get = () => {
      throw new Error("get() should not be called for a text-only run");
    };

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(promptIndexCalls).toBeGreaterThan(0);
  });
});
