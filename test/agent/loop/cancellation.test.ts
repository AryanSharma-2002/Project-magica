import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { buildTestHarness } from "../fakes/deps";
import { FakeStore } from "../fakes/store";
import { FakeCredits } from "../fakes/credits";
import { FakeRealtime } from "../fakes/realtime";
import { FakeDurable } from "../fakes/durable";
import { FakeWaitpoints } from "../fakes/waitpoints";
import { buildTestRegistry, makeTestTool } from "../fakes/tools";
import { makeFakeSkillRegistry } from "../fakes/skills";
import { ScriptedLlm, hangUntilAborted, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import type { RunDeps } from "@/agent/loop/ports";
import { noopLoggerForTests } from "../fakes/logger";

describe("runAgentTurn: cancellation", () => {
  it("stops between steps when a cancel is requested, making no further LLM calls", async () => {
    const run = makeRunRecord();
    const store = new FakeStore({ run, history: [userMessage("hi")] });
    const cropTool = makeTestTool({
      name: "crop_image",
      estimate: 10,
      execute: async (input) => {
        store.cancelRequested = true; // simulate a concurrent POST /runs/:id/cancel landing mid-tool
        return { output: { result: input.value }, microcreditsCharged: 10, durationMs: 1 };
      },
    });
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "crop_image", args: { value: 1 } }]), textTurn("should never run")]);

    const deps: RunDeps = {
      llm,
      tools: buildTestRegistry([cropTool]),
      skills: makeFakeSkillRegistry(),
      store,
      credits: new FakeCredits(1_000_000),
      realtime: new FakeRealtime(),
      durable: new FakeDurable(async () => {
        throw new Error("not used");
      }),
      waitpoints: new FakeWaitpoints([]),
      limits: DEFAULT_LIMITS,
      signal: new AbortController().signal,
      log: noopLoggerForTests(),
    };

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("cancelled");
    expect(llm.calls).toHaveLength(1);
    expect(store.finalizeCalls[0]!.input.status).toBe("cancelled");
    // The tool call that already ran is preserved.
    expect(store.finalizeCalls[0]!.input.blocks.some((b) => b.type === "tool_result" && b.status === "completed")).toBe(true);
  });

  it("aborts an in-flight LLM stream on cancellation, persisting partial blocks", async () => {
    const run = makeRunRecord();
    const controller = new AbortController();
    const llm = new ScriptedLlm([hangUntilAborted([{ type: "text_delta", delta: "partial answer" }])]);
    const { deps, store, realtime } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, signal: controller.signal });

    const promise = runAgentTurn(run.id, deps);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const outcome = await promise;

    expect(outcome.status).toBe("cancelled");
    expect(store.finalizeCalls[0]!.input.status).toBe("cancelled");
    expect(store.finalizeCalls[0]!.input.blocks.some((b) => b.type === "text" && b.text === "partial answer")).toBe(true);
    expect(realtime.textFor(0)).toBe("partial answer");
  });
});
