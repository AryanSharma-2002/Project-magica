import { describe, expect, it } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

describe("runAgentTurn: insufficient credits", () => {
  it("stops before executing a tool whose estimate exceeds the remaining balance, preserving earlier results", async () => {
    const run = makeRunRecord();
    let secondExecuteCalls = 0;
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 100,
      execute: async (input) => ({ output: { result: input.value }, microcreditsCharged: 100, durationMs: 1 }),
    });
    const mergeTool = makeTestTool({
      name: "merge_videos",
      estimate: 100,
      execute: async (input) => {
        secondExecuteCalls += 1;
        return { output: { result: input.value }, microcreditsCharged: 100, durationMs: 1 };
      },
    });

    const llm = new ScriptedLlm([
      toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]),
      toolCallTurn([{ id: "call_1", name: "merge_videos", args: { value: 2 } }]),
    ]);

    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool, mergeTool], balance: 150 });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("insufficient_credits");
    expect(secondExecuteCalls).toBe(0);

    const finalized = store.finalizeCalls[0]!.input;
    const results = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolCallId: "call_0", status: "completed" });
    expect(results[1]).toMatchObject({ toolCallId: "call_1", status: "failed" });
    expect(results[1]?.error?.code).toBe("insufficient_credits");
  });
});
