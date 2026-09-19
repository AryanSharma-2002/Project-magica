import { LoadSkillInput, LoadSkillOutput, ReadSkillAssetInput, ReadSkillAssetOutput } from "@agent-chat/contracts";
import { defineTool, type AnyToolDefinition } from "@/agent/tools/types";
import { AppError } from "@/lib/errors";
import type { SkillRegistry } from "./types";

/**
 * load_skill + read_skill_asset tool definitions (agent-engine slice).
 * group: "skills", execution: "inline", creditModel: free, requiresApproval: never.
 * Unknown skill -> AppError(validation_error) so the model gets a tool error and can recover.
 */
export function createSkillTools(registry: SkillRegistry): AnyToolDefinition[] {
  const loadSkill = defineTool({
    name: "load_skill",
    label: "Load skill",
    description: "Load the full guidance body for a skill by name. Call this only when the skill's description is relevant to the current task.",
    group: "skills",
    input: LoadSkillInput,
    output: LoadSkillOutput,
    creditModel: { type: "free" },
    requiresApproval: "never",
    execution: "inline",
    estimate: async () => 0,
    execute: async (input) => {
      const skill = registry.get(input.name);
      if (!skill) throw new AppError("validation_error", "Unknown skill", { details: { name: input.name } });
      return {
        output: {
          name: skill.name,
          ...(skill.version !== undefined ? { version: skill.version } : {}),
          contentHash: skill.contentHash,
          body: skill.body,
          assets: skill.assets,
        },
        microcreditsCharged: 0,
        durationMs: 0,
      };
    },
    effects: (output) => [{ type: "record_skill", skillName: output.name, assetPath: "", contentHash: output.contentHash }],
  });

  const readSkillAsset = defineTool({
    name: "read_skill_asset",
    label: "Read skill asset",
    description: "Read an asset file bundled with a skill (e.g. reference tables, checklists) by its relative path.",
    group: "skills",
    input: ReadSkillAssetInput,
    output: ReadSkillAssetOutput,
    creditModel: { type: "free" },
    requiresApproval: "never",
    execution: "inline",
    estimate: async () => 0,
    execute: async (input) => {
      if (!registry.get(input.name)) throw new AppError("validation_error", "Unknown skill", { details: { name: input.name } });
      const asset = await registry.readAsset(input.name, input.path);
      return {
        output: {
          name: input.name,
          path: asset.path,
          contentHash: asset.contentHash,
          mimeType: asset.mimeType,
          content: asset.content,
        },
        microcreditsCharged: 0,
        durationMs: 0,
      };
    },
    effects: (output) => [{ type: "record_skill", skillName: output.name, assetPath: output.path, contentHash: output.contentHash }],
  });

  return [loadSkill as unknown as AnyToolDefinition, readSkillAsset as unknown as AnyToolDefinition];
}
