import type { AnyToolDefinition } from "@/agent/tools/types";
import type { SkillRegistry } from "./types";

/**
 * load_skill + read_skill_asset tool definitions (agent-engine slice).
 * group: "skills", execution: "inline", creditModel: free, requiresApproval: never,
 * effects: [{ type: "record_skill", skillName, assetPath, contentHash }].
 */
export function createSkillTools(_registry: SkillRegistry): AnyToolDefinition[] {
  return [];
}
