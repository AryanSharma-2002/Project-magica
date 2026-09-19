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

  it("still executes and settles an earlier call in the SAME batch that already cleared its credit check", async () => {
    // call_0 clears its check and reserves first; call_1 (later in the same batch) then fails its
    // check. call_0 must still run to completion (settled, not left with a dangling reservation)
    // rather than being abandoned because a LATER call in the batch stopped the run.
    const run = makeRunRecord();
    let firstExecuteCalls = 0;
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 100,
      execute: async (input) => {
        firstExecuteCalls += 1;
        return { output: { result: input.value }, microcreditsCharged: 100, durationMs: 1 };
      },
    });
    const mergeTool = makeTestTool({ name: "merge_videos", estimate: 100 });

    const llm = new ScriptedLlm([
      toolCallTurn([
        { id: "call_0", name: "crop_image", args: { value: 1 } },
        { id: "call_1", name: "merge_videos", args: { value: 2 } },
      ]),
    ]);

    const { deps, store, credits } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool, mergeTool], balance: 100 });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("insufficient_credits");
    expect(firstExecuteCalls).toBe(1);
    // call_0's reservation was settled (charged), not left dangling.
    expect(credits.settled).toHaveLength(1);
    expect(credits.settled[0]).toMatchObject({ charged: 100 });

    const finalized = store.finalizeCalls[0]!.input;
    const results = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    // Order preserved despite call_0 being deferred (parallel-executed) and call_1 resolving
    // immediately (credit failure) - call_0's result still comes first.
    expect(results.map((r) => r.toolCallId)).toEqual(["call_0", "call_1"]);
    expect(results[0]).toMatchObject({ status: "completed" });
    expect(results[1]).toMatchObject({ status: "failed" });
  });
});
