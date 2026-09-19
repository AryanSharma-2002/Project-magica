import { describe, expect, it } from "vitest";
import { createSkillTools } from "@/agent/skills/tools";
import type { LoadedSkill, SkillAsset, SkillRegistry } from "@/agent/skills/types";
import type { ToolContext } from "@/agent/tools/types";

function fakeCtx(): ToolContext {
  return {
    userId: "user-1",
    runId: "run-1",
    chatId: "chat-1",
    invocationId: "inv-1",
    toolCallId: "call-1",
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as ToolContext["log"],
    attachments: [],
  };
}

function fakeRegistry(skills: LoadedSkill[], assets: Record<string, SkillAsset>): SkillRegistry {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    list: () => skills.map(({ body: _body, dir: _dir, ...rest }) => rest),
    get: (name) => byName.get(name),
    readAsset: async (name, rel) => {
      const key = `${name}:${rel}`;
      const asset = assets[key];
      if (!asset) throw new Error("not found");
      return asset;
    },
    promptIndex: () => "index",
  };
}

const demoSkill: LoadedSkill = {
  name: "demo",
  description: "Demo skill",
  version: "1.0.0",
  assets: ["notes.md"],
  contentHash: "a".repeat(64),
  body: "# Demo body",
  dir: "/tmp/demo",
};

describe("createSkillTools", () => {
  it("load_skill returns the body and records a skill effect", async () => {
    const registry = fakeRegistry([demoSkill], {});
    const [loadSkill] = createSkillTools(registry);
    const result = await loadSkill!.execute({ name: "demo" }, fakeCtx());
    expect(result.output).toMatchObject({ name: "demo", version: "1.0.0", body: "# Demo body", assets: ["notes.md"] });
    expect(result.microcreditsCharged).toBe(0);
    const effects = loadSkill!.effects?.(result.output as never, fakeCtx());
    expect(effects).toEqual([{ type: "record_skill", skillName: "demo", assetPath: "", contentHash: "a".repeat(64) }]);
  });

  it("load_skill throws a validation_error tool error for an unknown skill", async () => {
    const registry = fakeRegistry([], {});
    const [loadSkill] = createSkillTools(registry);
    await expect(loadSkill!.execute({ name: "ghost" }, fakeCtx())).rejects.toMatchObject({ code: "validation_error" });
  });

  it("read_skill_asset returns asset content and records a skill effect with the asset path", async () => {
    const asset: SkillAsset = { path: "notes.md", mimeType: "text/markdown", content: "asset body", contentHash: "b".repeat(64) };
    const registry = fakeRegistry([demoSkill], { "demo:notes.md": asset });
    const [, readSkillAsset] = createSkillTools(registry);
    const result = await readSkillAsset!.execute({ name: "demo", path: "notes.md" }, fakeCtx());
    expect(result.output).toEqual({ name: "demo", path: "notes.md", contentHash: "b".repeat(64), mimeType: "text/markdown", content: "asset body" });
    const effects = readSkillAsset!.effects?.(result.output as never, fakeCtx());
    expect(effects).toEqual([{ type: "record_skill", skillName: "demo", assetPath: "notes.md", contentHash: "b".repeat(64) }]);
  });

  it("read_skill_asset throws a validation_error tool error for an unknown skill", async () => {
    const registry = fakeRegistry([], {});
    const [, readSkillAsset] = createSkillTools(registry);
    await expect(readSkillAsset!.execute({ name: "ghost", path: "x.md" }, fakeCtx())).rejects.toMatchObject({ code: "validation_error" });
  });

  it("both tools are free, inline, never-approval, skills-group", () => {
    const registry = fakeRegistry([demoSkill], {});
    const tools = createSkillTools(registry);
    for (const t of tools) {
      expect(t.group).toBe("skills");
      expect(t.execution).toBe("inline");
      expect(t.creditModel).toEqual({ type: "free" });
      expect(t.requiresApproval).toBe("never");
    }
  });
});
