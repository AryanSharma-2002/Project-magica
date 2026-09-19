import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@agent-chat/contracts";
import { buildSystemPrompt } from "@/agent/prompt/system";
import type { SkillRegistry } from "@/agent/skills/types";

function fakeSkillRegistry(index = "Skills available via load_skill:\n- demo: A demo skill"): SkillRegistry {
  return {
    list: () => [],
    get: () => undefined,
    readAsset: async () => {
      throw new Error("not used in this test");
    },
    promptIndex: () => index,
  };
}

describe("buildSystemPrompt", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("includes persona, tool policy, skill index, and date", () => {
    const prompt = buildSystemPrompt({ skills: fakeSkillRegistry(), limits: DEFAULT_LIMITS, now, attachments: [], planMode: false });
    expect(prompt).toMatch(/Galaxy agent/);
    expect(prompt).toMatch(/Never invent a URL/);
    expect(prompt).toContain("Skills available via load_skill:\n- demo: A demo skill");
    expect(prompt).toContain("2026-09-19T12:00:00.000Z");
  });

  it("lists attachments when present", () => {
    const prompt = buildSystemPrompt({
      skills: fakeSkillRegistry(),
      limits: DEFAULT_LIMITS,
      now,
      attachments: [{ kind: "image", url: "https://example.com/a.png" }],
      planMode: false,
    });
    expect(prompt).toContain("Attachments available in this turn:");
    expect(prompt).toContain("- image: https://example.com/a.png");
  });

  it("states no attachments when none are present", () => {
    const prompt = buildSystemPrompt({ skills: fakeSkillRegistry(), limits: DEFAULT_LIMITS, now, attachments: [], planMode: false });
    expect(prompt).toContain("No attachments are available in this turn.");
  });

  it("restores loaded skill bodies for resumed runs", () => {
    const prompt = buildSystemPrompt({
      skills: fakeSkillRegistry(),
      limits: DEFAULT_LIMITS,
      now,
      attachments: [],
      planMode: false,
      loadedSkills: [{ name: "image-cropping", body: "Full guidance body." }],
    });
    expect(prompt).toContain("--- image-cropping ---");
    expect(prompt).toContain("Full guidance body.");
  });

  it("adds a plan-mode instruction only when planMode is true", () => {
    const withPlan = buildSystemPrompt({ skills: fakeSkillRegistry(), limits: DEFAULT_LIMITS, now, attachments: [], planMode: true });
    const withoutPlan = buildSystemPrompt({ skills: fakeSkillRegistry(), limits: DEFAULT_LIMITS, now, attachments: [], planMode: false });
    expect(withPlan).toMatch(/Plan mode is ON/);
    expect(withoutPlan).not.toMatch(/Plan mode is ON/);
  });

  it("is deterministic for the same inputs", () => {
    const args = { skills: fakeSkillRegistry(), limits: DEFAULT_LIMITS, now, attachments: [], planMode: false } as const;
    expect(buildSystemPrompt(args)).toBe(buildSystemPrompt(args));
  });
});
