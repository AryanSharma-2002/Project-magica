import { describe, expect, it } from "vitest";
import { getSkillRegistry, __resetSkillRegistryForTests } from "@/agent/skills";

describe("getSkillRegistry (real agent-skills/ directory)", () => {
  it("scans the shipped skills with no validation issues", () => {
    __resetSkillRegistryForTests();
    const registry = getSkillRegistry();
    const names = registry.list().map((s) => s.name).sort();
    expect(names).toEqual(["image-cropping", "image-generation", "media-workflows", "video-merging"]);
    for (const skill of registry.list()) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is memoized across calls", () => {
    __resetSkillRegistryForTests();
    const a = getSkillRegistry();
    const b = getSkillRegistry();
    expect(a).toBe(b);
  });

  it("ships the documented assets for each skill", () => {
    __resetSkillRegistryForTests();
    const registry = getSkillRegistry();
    expect(registry.get("image-generation")?.assets).toEqual(["size-presets.md"]);
    expect(registry.get("image-cropping")?.assets).toEqual(["aspect-ratios.md"]);
    expect(registry.get("video-merging")?.assets).toEqual(["checklist.md"]);
  });
});
