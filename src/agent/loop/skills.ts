import type { ReasoningBlock } from "@agent-chat/contracts";
import type { LoadedSkillForPrompt } from "@/agent/prompt/system";
import type { SkillRegistry } from "@/agent/skills/types";
import type { RunSnapshot } from "./ports";

export type SkillCacheSeed = {
  /** Keyed like skillDedupeKey() in tools.ts: "load_skill:<name>" / "read_skill_asset:<name>:<path>". */
  cache: Map<string, unknown>;
  /** Full bodies to restore into the system prompt so a resumed run sees the same guidance. */
  loadedSkillsForPrompt: LoadedSkillForPrompt[];
  /** Pushed at the start of the run when the registry's current content differs from what was recorded. */
  hashMismatchReasoning: ReasoningBlock[];
};

/**
 * Seeds the in-run skill dedupe cache from a resumed run's `snapshot.loadedSkills`, by looking up
 * the CURRENT registry content (never by re-invoking the load_skill/read_skill_asset tools). If the
 * registry's current content hash differs from what was recorded, the newer version is used and a
 * reasoning block notes the discrepancy (per ARCHITECTURE.md §8 durability + resume guidance).
 */
export async function seedSkillCache(skills: SkillRegistry, loadedSkills: RunSnapshot["loadedSkills"]): Promise<SkillCacheSeed> {
  const cache = new Map<string, unknown>();
  const bodyByName = new Map<string, string>();
  const hashMismatchReasoning: ReasoningBlock[] = [];

  for (const entry of loadedSkills) {
    const skill = skills.get(entry.skillName);
    if (!skill) continue; // no longer exists; a fresh load_skill call will surface "Unknown skill"

    if (entry.assetPath === "") {
      cache.set(`load_skill:${entry.skillName}`, {
        name: skill.name,
        ...(skill.version !== undefined ? { version: skill.version } : {}),
        contentHash: skill.contentHash,
        body: skill.body,
        assets: skill.assets,
      });
      bodyByName.set(entry.skillName, skill.body);
      if (skill.contentHash !== entry.contentHash) {
        hashMismatchReasoning.push({
          type: "reasoning",
          text: `The "${entry.skillName}" skill was updated since it was last loaded in this run; using the latest version.`,
        });
      }
      continue;
    }

    try {
      const asset = await skills.readAsset(entry.skillName, entry.assetPath);
      cache.set(`read_skill_asset:${entry.skillName}:${entry.assetPath}`, {
        name: entry.skillName,
        path: asset.path,
        contentHash: asset.contentHash,
        mimeType: asset.mimeType,
        content: asset.content,
      });
      if (!bodyByName.has(entry.skillName)) bodyByName.set(entry.skillName, skill.body);
      if (asset.contentHash !== entry.contentHash) {
        hashMismatchReasoning.push({
          type: "reasoning",
          text: `The "${entry.assetPath}" asset of skill "${entry.skillName}" was updated since it was last loaded in this run; using the latest version.`,
        });
      }
    } catch {
      // asset no longer readable; a fresh read_skill_asset call will surface the concrete error
    }
  }

  const loadedSkillsForPrompt: LoadedSkillForPrompt[] = [...bodyByName.entries()]
    .map(([name, body]) => ({ name, body }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { cache, loadedSkillsForPrompt, hashMismatchReasoning };
}
