import { describe, expect, it } from "vitest";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";
import type { LlmMessage } from "@/agent/llm/types";

describe("runAgentTurn: cross-turn message construction", () => {
  it("sends the model its own prior tool_calls and tool results on the next turn (not a repeat of turn 1's prompt)", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });
    const llm = new ScriptedLlm([
      toolCallTurn([
        { id: "call_0", name: "crop_image", args: { value: 1 } },
        { id: "call_1", name: "crop_image", args: { value: 2 } },
      ]),
      textTurn("Done!"),
    ]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool] });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);

    const turn1Messages = llm.calls[0]!.messages;
    const turn2Messages = llm.calls[1]!.messages;

    // Turn 1 saw only the system + user message: no assistant tail yet.
    expect(turn1Messages.map((m) => m.role)).toEqual(["system", "user"]);

    // Turn 2 must NOT be identical to turn 1 - it needs the assistant's tool_calls and their results.
    expect(turn2Messages).not.toEqual(turn1Messages);
    const assistantMsg = turn2Messages.find((m) => m.role === "assistant") as Extract<LlmMessage, { role: "assistant" }> | undefined;
    expect(assistantMsg?.toolCalls?.map((tc) => tc.id)).toEqual(["call_0", "call_1"]);

    const toolMessages = turn2Messages.filter((m) => m.role === "tool") as Array<Extract<LlmMessage, { role: "tool" }>>;
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(["call_0", "call_1"]);
    expect(JSON.parse(toolMessages[0]!.content)).toEqual({ result: 2 });
    expect(JSON.parse(toolMessages[1]!.content)).toEqual({ result: 4 });

    // Ordering: system, user, assistant(tool_calls), tool, tool.
    expect(turn2Messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
  });

  it("sends a synthesized error tool message when a tool_use has no matching tool_result in the accumulated blocks", async () => {
    // Simulate a run resumed with a persisted tool_use block but no tool_result (died mid-tool).
    const run = makeRunRecord();
    const llm = new ScriptedLlm([textTurn("Continuing.")]);
    const { deps } = buildTestHarness({
      store: {
        run,
        history: [userMessage("hi")],
        persistedBlocks: [{ type: "tool_use", toolCallId: "call_0", invocationId: "inv_0", toolName: "crop_image", input: { value: 1 } }],
      },
      llm,
    });

    await runAgentTurn(run.id, deps);
    const messages = llm.calls[0]!.messages;
    const toolMsg = messages.find((m) => m.role === "tool") as Extract<LlmMessage, { role: "tool" }> | undefined;
    expect(toolMsg).toBeTruthy();
    expect(JSON.parse(toolMsg!.content)).toMatchObject({ error: { code: "internal" } });
  });
});
