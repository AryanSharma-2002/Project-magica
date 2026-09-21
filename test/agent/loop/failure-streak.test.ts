import { describe, expect, it } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { MAX_CONSECUTIVE_TOOL_FAILURES } from "@/agent/loop/tools";
import { AppError } from "@/lib/errors";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeTestTool } from "../fakes/tools";

const call = (id: string, name: "crop_image" | "merge_videos" | "gpt_image_2") => ({ id, name, args: { value: 1 } });

function toolResults(blocks: ReadonlyArray<{ type: string }>): ToolResultBlock[] {
  return blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

/**
 * Two live findings from the 2026-09-21 acceptance run:
 *  - a tool that fails AFTER the provider completed and billed must settle that charge, not
 *    release the reservation;
 *  - a model kept retrying a failing paid tool turn after turn (each retry billed by the provider)
 *    until the run had to be cancelled by hand.
 */
describe("runAgentTurn: tool failure accounting", () => {
  it("settles the provider's charge (not a release) when the failure carries microcreditsCharged", async () => {
    const run = makeRunRecord();
    const billedFailure = makeTestTool({
      name: "crop_image",
      estimate: 5000,
      execute: async () => {
        throw new AppError("provider_error", "Media provider returned an unexpected result", { retryable: false, details: { providerRunId: "prov_billed", microcreditsCharged: 5000 } });
      },
    });
    const llm = new ScriptedLlm([toolCallTurn([call("call_0", "crop_image")]), textTurn("Sorry, that failed.")]);
    const { deps, store, credits } = buildTestHarness({ store: { run, history: [userMessage("crop it")] }, llm, tools: [billedFailure] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed"); // one failure is not a streak
    expect(credits.settled).toEqual([{ invocationId: expect.any(String), estimated: 5000, charged: 5000 }]);
    expect(credits.released).toEqual([]);
    const invocation = store.getInvocation("call_0");
    expect(invocation).toMatchObject({ status: "failed", microcreditsCharged: 5000, providerRunId: "prov_billed" });
    const [result] = toolResults(store.finalizeCalls[0]!.input.blocks);
    expect(result).toMatchObject({ status: "failed", microcredits: 5000, error: { code: "provider_error", retryable: false } });
  });

  it("releases the reservation when the failure carries no charge", async () => {
    const run = makeRunRecord();
    const plainFailure = makeTestTool({
      name: "crop_image",
      estimate: 5000,
      execute: async () => {
        throw new AppError("provider_error", "boom", { retryable: true });
      },
    });
    const llm = new ScriptedLlm([toolCallTurn([call("call_0", "crop_image")]), textTurn("Sorry.")]);
    const { deps, credits } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [plainFailure] });

    await runAgentTurn(run.id, deps);

    expect(credits.released).toEqual([{ invocationId: expect.any(String), estimated: 5000 }]);
    expect(credits.settled).toEqual([]);
  });
});

describe("runAgentTurn: consecutive tool-failure guard", () => {
  const alwaysFails = (name: "crop_image" | "merge_videos") =>
    makeTestTool({
      name,
      estimate: 100,
      execute: async () => {
        throw new AppError("provider_error", "boom", { retryable: true });
      },
    });

  it(`stops the run as provider_error after ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive failures of one tool, instead of looping to maxTurnsPerRun`, async () => {
    const run = makeRunRecord();
    const llm = new ScriptedLlm([
      toolCallTurn([call("call_0", "crop_image")]),
      toolCallTurn([call("call_1", "crop_image")]),
      toolCallTurn([call("call_2", "crop_image")]),
      textTurn("never reached"),
    ]);
    const { deps, store, credits } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [alwaysFails("crop_image")] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({ code: "provider_error", retryable: false, details: { toolName: "crop_image", consecutiveFailures: MAX_CONSECUTIVE_TOOL_FAILURES } });
    expect(llm.calls).toHaveLength(MAX_CONSECUTIVE_TOOL_FAILURES);
    expect(credits.released).toHaveLength(MAX_CONSECUTIVE_TOOL_FAILURES); // every attempt settled, none dangling
    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.status).toBe("failed");
    expect(toolResults(finalized.blocks).map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("resets the streak on a success, so fail / succeed / fail continues", async () => {
    const run = makeRunRecord();
    let attempt = 0;
    const flaky = makeTestTool({
      name: "crop_image",
      estimate: 100,
      execute: async (input) => {
        attempt += 1;
        if (attempt === 2) return { output: { result: input.value }, microcreditsCharged: 100, durationMs: 1 };
        throw new AppError("provider_error", "boom", { retryable: true });
      },
    });
    const llm = new ScriptedLlm([
      toolCallTurn([call("call_0", "crop_image")]),
      toolCallTurn([call("call_1", "crop_image")]),
      toolCallTurn([call("call_2", "crop_image")]),
      textTurn("Done with what I could."),
    ]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [flaky] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(4);
  });

  it("counts per tool name: one failure each of two different tools does not stop the run", async () => {
    const run = makeRunRecord();
    const llm = new ScriptedLlm([toolCallTurn([call("call_0", "crop_image"), call("call_1", "merge_videos")]), textTurn("Both failed, sorry.")]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, tools: [alwaysFails("crop_image"), alwaysFails("merge_videos")] });

    const outcome = await runAgentTurn(run.id, deps);

    expect(outcome.status).toBe("completed");
    expect(llm.calls).toHaveLength(2);
  });
});
