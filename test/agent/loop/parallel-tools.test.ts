import { describe, expect, it } from "vitest";
import type { ToolResultBlock, ToolUseBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

describe("runAgentTurn: parallel tool calls", () => {
  it("appends tool_result blocks in call order even when the second call finishes first, charging each once", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 100,
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { output: { result: input.value }, microcreditsCharged: 100, durationMs: 25 };
      },
    });
    const mergeTool = makeTestTool({
      name: "merge_videos",
      estimate: 200,
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { output: { result: input.value }, microcreditsCharged: 200, durationMs: 5 };
      },
    });

    const llm = new ScriptedLlm([
      toolCallTurn([
        { id: "call_0", name: "crop_image", args: { value: 1 } },
        { id: "call_1", name: "merge_videos", args: { value: 2 } },
      ]),
      textTurn("Done!"),
    ]);

    const { deps, store, credits } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool, mergeTool] });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");

    const finalized = store.finalizeCalls[0]!.input;
    const toolUses = finalized.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");

    expect(toolUses.map((b) => b.toolCallId)).toEqual(["call_0", "call_1"]);
    // Despite merge_videos (call_1) finishing first, results are appended in original call order.
    expect(toolResults.map((b) => b.toolCallId)).toEqual(["call_0", "call_1"]);
    expect(toolResults.every((b) => b.status === "completed")).toBe(true);

    expect(credits.settled).toHaveLength(2);
    expect(credits.settled.find((s) => s.charged === 100)).toBeTruthy();
    expect(credits.settled.find((s) => s.charged === 200)).toBeTruthy();

    expect(finalized.usage.llmCalls).toBe(2);
  });
});
