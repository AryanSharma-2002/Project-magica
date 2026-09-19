import { describe, expect, it } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

describe("runAgentTurn: resuming with an existing terminal invocation", () => {
  it("does not re-execute or re-charge a tool call that already has a terminal invocation", async () => {
    const run = makeRunRecord();
    let executeCalls = 0;
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 100,
      execute: async (input) => {
        executeCalls += 1;
        return { output: { result: input.value }, microcreditsCharged: 100, durationMs: 1 };
      },
    });

    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Done!")]);

    const { deps, store, credits } = buildTestHarness({
      store: {
        run,
        history: [userMessage("hi")],
        existingInvocations: [
          {
            invocationId: "inv_existing",
            runId: run.id,
            toolCallId: "call_0",
            toolName: "crop_image",
            status: "completed",
            input: { value: 1 },
            output: { result: 2 },
            microcreditsCharged: 100,
            microcreditsEstimated: 100,
            providerRunId: null,
          },
        ],
      },
      llm,
      tools: [cropTool],
    });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(executeCalls).toBe(0);
    expect(credits.reserved).toHaveLength(0);
    expect(credits.settled).toHaveLength(0);

    const finalized = store.finalizeCalls[0]!.input;
    const result = finalized.blocks.find((b): b is ToolResultBlock => b.type === "tool_result" && b.toolCallId === "call_0");
    expect(result).toMatchObject({ status: "completed", output: { result: 2 }, microcredits: 100 });
  });
});
