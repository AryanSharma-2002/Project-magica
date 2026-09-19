import { describe, expect, it } from "vitest";
import type { ToolResultBlock, ToolUseBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool, makeThrowingTool } from "../fakes/tools";
import { FakeStore } from "../fakes/store";

describe("runAgentTurn: durable tool execution", () => {
  it("dispatches a durable_child_task tool via DurableExecutor and records its providerRunId", async () => {
    const run = makeRunRecord();
    const mergeTool = makeTestTool({ name: "merge_videos", estimate: 50, execution: "durable_child_task" });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "merge_videos", args: { value: 5 } }]), textTurn("Done!")]);
    const { deps, store } = buildTestHarness({
      store: { run, history: [userMessage("hi")] },
      llm,
      tools: [mergeTool],
      durableHandler: async () => ({ output: { result: 99 }, microcreditsCharged: 50, durationMs: 10, providerRunId: "prov_123" }),
    });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(deps.durable).toBeDefined();

    const record = store.getInvocation("call_0");
    expect(record?.status).toBe("completed");
    expect(record?.providerRunId).toBe("prov_123");

    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result).toMatchObject({ status: "completed", output: { result: 99 } });
  });
});

describe("runAgentTurn: a tool that throws", () => {
  it("marks the invocation failed, releases the credit reservation, and lets the run continue", async () => {
    const run = makeRunRecord();
    const badTool = makeThrowingTool({ name: "crop_image", estimate: 100, error: new Error("boom") });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("It failed, sorry.")]);
    const { deps, store, credits } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [badTool] });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(credits.released).toHaveLength(1);
    expect(credits.released[0]).toMatchObject({ estimated: 100 });
    expect(credits.settled).toHaveLength(0);

    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("failed");
    expect(result?.error?.code).toBe("internal");
  });
});

describe("runAgentTurn: per-turn tool-call cap", () => {
  it("cancels calls beyond limits.maxToolCallsPerTurn without executing them", async () => {
    const run = makeRunRecord();
    let executeCalls = 0;
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 10,
      execute: async (input) => {
        executeCalls += 1;
        return { output: { result: input.value }, microcreditsCharged: 10, durationMs: 1 };
      },
    });
    const llm = new ScriptedLlm([
      toolCallTurn([
        { id: "call_0", name: "crop_image", args: { value: 1 } },
        { id: "call_1", name: "crop_image", args: { value: 2 } },
      ]),
      textTurn("Done!"),
    ]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool], limits: { maxToolCallsPerTurn: 1 } });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(executeCalls).toBe(1);

    const results = store.finalizeCalls[0]!.input.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    expect(results.map((r) => ({ id: r.toolCallId, status: r.status }))).toEqual([
      { id: "call_0", status: "completed" },
      { id: "call_1", status: "cancelled" },
    ]);
  });
});

describe("runAgentTurn: markRunning returns false", () => {
  it("finalizes CANCELLED without making any LLM calls", async () => {
    const run = makeRunRecord();
    const llm = new ScriptedLlm([textTurn("should never run")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")], markRunningResult: false }, llm });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(0);
    expect(store.finalizeCalls).toHaveLength(1);
    expect(store.finalizeCalls[0]!.input.status).toBe("cancelled");
  });
});

describe("runAgentTurn: unexpected failure in loadSnapshot", () => {
  it("catches the throw and finalizes FAILED with a generic safe message", async () => {
    const run = makeRunRecord();
    const store = new FakeStore({ run, history: [userMessage("hi")] });
    store.loadSnapshot = async () => {
      throw new Error("db exploded");
    };
    const llm = new ScriptedLlm([textTurn("should never run")]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, storeOverride: store });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("internal");
    expect(outcome.error?.message).not.toContain("db exploded");
    expect(store.finalizeCalls).toHaveLength(1);
  });
});

describe("runAgentTurn: sanitizeInput", () => {
  it("persists the sanitized shape on the tool_use block, not the raw parsed input", async () => {
    const run = makeRunRecord();
    const cropTool = makeTestTool({ name: "crop_image", estimate: 10, sanitizeInput: (input) => ({ value: input.value, secret: undefined as never }) });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 7 } }]), textTurn("Done!")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [cropTool] });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    const toolUse = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolUseBlock => b.type === "tool_use");
    expect(toolUse?.input).toEqual({ value: 7 });
  });
});
