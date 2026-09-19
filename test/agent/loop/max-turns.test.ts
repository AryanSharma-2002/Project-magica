import { describe, expect, it } from "vitest";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

describe("runAgentTurn: max turns", () => {
  it("fails with max_turns_exceeded after limits.maxTurnsPerRun LLM calls, preserving blocks", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });
    // Always asks for another tool call, so the run never reaches a natural stop.
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call", name: "crop_image", args: { value: 1 } }])]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], limits: { maxTurnsPerRun: 2 } });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("max_turns_exceeded");
    expect(llm.calls).toHaveLength(2);
    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });
});
