import { describe, expect, it } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

describe("runAgentTurn: malformed tool calls", () => {
  it("allows one repair round: malformed then valid succeeds", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });

    const llm = new ScriptedLlm([
      toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: "not-a-number" } }]),
      toolCallTurn([{ id: "call_1", name: "crop_image", args: { value: 3 } }]),
      textTurn("Done!"),
    ]);

    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool] });
    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    const finalized = store.finalizeCalls[0]!.input;
    const results = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolCallId: "call_0", status: "failed" });
    expect(results[0]?.error?.code).toBe("malformed_tool_call");
    expect(results[1]).toMatchObject({ toolCallId: "call_1", status: "completed" });
  });

  it("fails the run when the same tool is malformed twice in a row", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });

    const llm = new ScriptedLlm([
      toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: "nope" } }]),
      toolCallTurn([{ id: "call_1", name: "crop_image", args: { value: "still-nope" } }]),
    ]);

    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool] });
    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("malformed_tool_call");
    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.error?.code).toBe("malformed_tool_call");
    const results = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "failed")).toBe(true);
    // Only 2 LLM calls happened (no third repair attempt after the second failure).
    expect(llm.calls).toHaveLength(2);
  });
});
