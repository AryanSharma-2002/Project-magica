import { describe, expect, it } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";
import { approve, approvePlan, decline, declinePlan, expired } from "../fakes/waitpoints";

describe("runAgentTurn: approval waitpoints", () => {
  it("asks for approval above the threshold and executes once approved", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 100_000, requiresApproval: "above_threshold" });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Done!")]);
    const { deps, store, waitpoints } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], waitpointScript: [approve()] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(waitpoints.asks).toHaveLength(1);
    expect(waitpoints.asks[0]?.type).toBe("approval");
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("completed");
    expect(store.statusHistory).toEqual(["waiting", "running"]);
  });

  it("cancels the tool call when approval is declined, and the model continues", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 100_000, requiresApproval: "above_threshold" });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Okay, skipped that.")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], waitpointScript: [decline()] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(2);
  });

  it("fails the run with waitpoint_expired when approval times out", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 100_000, requiresApproval: "above_threshold" });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }])]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], waitpointScript: [expired()] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("waitpoint_expired");
    expect(store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result")?.status).toBe("cancelled");
  });

  it("does not ask for approval below the threshold", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 100, requiresApproval: "above_threshold" });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Done!")]);
    const { deps, waitpoints, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(waitpoints.asks).toHaveLength(0);
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("completed");
  });
});

describe("runAgentTurn: plan mode", () => {
  it("asks a plan waitpoint before the first tool batch and executes once approved", async () => {
    const run = makeRunRecord({ planMode: true });
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Done!")]);
    const { deps, waitpoints, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], waitpointScript: [approvePlan()] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(waitpoints.asks[0]?.type).toBe("plan");
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("completed");
  });

  it("cancels all calls in the first batch when the plan is declined, and the model continues", async () => {
    const run = makeRunRecord({ planMode: true });
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10 });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("Okay, not doing that.")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], waitpointScript: [declinePlan()] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("cancelled");
  });
});
