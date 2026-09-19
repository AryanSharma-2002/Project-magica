import { describe, expect, it, vi } from "vitest";
import type { ToolResultBlock } from "@agent-chat/contracts";
import { LoadSkillOutput } from "@agent-chat/contracts";
import { runAgentTurn } from "@/agent/loop/index";
import { createSkillTools } from "@/agent/skills/tools";
import type { LoadedSkill } from "@/agent/skills/types";
import { buildTestHarness } from "../fakes/deps";
import { ScriptedLlm, textTurn, toolCallTurn } from "../fakes/llm";
import { makeRunRecord, userMessage } from "../fakes/builders";
import { makeFakeSkillRegistry } from "../fakes/skills";

const demoSkill: LoadedSkill = {
  name: "demo-skill",
  description: "Demo skill for tests",
  contentHash: "a".repeat(64),
  assets: [],
  body: "# Demo skill body\n\nUse this guidance for demos.",
  dir: "/fake/demo-skill",
};

describe("runAgentTurn: skills", () => {
  it("does not touch the skill registry beyond promptIndex on a text-only run", async () => {
    const run = makeRunRecord();
    const skills = makeFakeSkillRegistry([demoSkill]);
    const getSpy = vi.spyOn(skills, "get");
    const llm = new ScriptedLlm([textTurn("hi")]);
    const { deps } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, skills });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("dedupes a repeated load_skill call within the same run", async () => {
    const run = makeRunRecord();
    const skills = makeFakeSkillRegistry([demoSkill]);
    const getSpy = vi.spyOn(skills, "get");
    const skillTools = createSkillTools(skills);

    const llm = new ScriptedLlm([
      toolCallTurn([{ id: "call_0", name: "load_skill", args: { name: "demo-skill" } }]),
      toolCallTurn([{ id: "call_1", name: "load_skill", args: { name: "demo-skill" } }]),
      textTurn("Done!"),
    ]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, skills, tools: skillTools });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    // registry.get is called once per real execute(); the second (deduped) call short-circuits it.
    expect(getSpy).toHaveBeenCalledTimes(1);

    const finalized = store.finalizeCalls[0]!.input;
    const results = finalized.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("completed");
    expect(results[1]?.status).toBe("completed");
    const output0 = LoadSkillOutput.parse(results[0]!.output);
    const output1 = LoadSkillOutput.parse(results[1]!.output);
    expect(output1).toEqual(output0);

    // Both loads are recorded (idempotent RunSkill upserts), regardless of dedupe.
    expect(store.recordedSkills.filter((s) => s.skillName === "demo-skill")).toHaveLength(2);
  });

  it("returns a tool error for an unknown skill and the run continues", async () => {
    const run = makeRunRecord();
    const skills = makeFakeSkillRegistry([demoSkill]);
    const skillTools = createSkillTools(skills);
    const llm = new ScriptedLlm([toolCallTurn([{ id: "call_0", name: "load_skill", args: { name: "ghost-skill" } }]), textTurn("No such skill.")]);
    const { deps, store } = buildTestHarness({ store: { run, history: [userMessage("hi")] }, llm, skills, tools: skillTools });

    const outcome = await runAgentTurn(run.id, deps);
    expect(outcome.status).toBe("completed");
    const result = store.finalizeCalls[0]!.input.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.status).toBe("failed");
    expect(result?.error?.code).toBe("validation_error");
  });

  it("restores a previously loaded skill's body into the system prompt on resume", async () => {
    const run = makeRunRecord();
    const skills = makeFakeSkillRegistry([demoSkill]);
    const llm = new ScriptedLlm([textTurn("hi")]);
    const { deps } = buildTestHarness({
      store: { run, history: [userMessage("hi")], loadedSkills: [{ skillName: "demo-skill", assetPath: "", contentHash: demoSkill.contentHash }] },
      llm,
      skills,
    });

    await runAgentTurn(run.id, deps);
    const systemMessage = llm.calls[0]?.messages[0];
    expect(systemMessage?.role).toBe("system");
    expect((systemMessage as { content: string }).content).toContain("Demo skill body");
  });

  it("notes a hash mismatch with a reasoning block when the registry content has changed since it was recorded", async () => {
    const run = makeRunRecord();
    const skills = makeFakeSkillRegistry([demoSkill]);
    const llm = new ScriptedLlm([textTurn("hi")]);
    const { deps, store } = buildTestHarness({
      store: { run, history: [userMessage("hi")], loadedSkills: [{ skillName: "demo-skill", assetPath: "", contentHash: "stale-hash".padEnd(64, "0") }] },
      llm,
      skills,
    });

    await runAgentTurn(run.id, deps);
    const finalized = store.finalizeCalls[0]!.input;
    expect(finalized.blocks.some((b) => b.type === "reasoning" && b.text.includes("demo-skill"))).toBe(true);
  });
});
