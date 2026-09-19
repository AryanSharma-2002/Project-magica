import { ToolRegistry } from "./registry";
import { createSkillTools } from "@/agent/skills/tools";
import { getSkillRegistry } from "@/agent/skills";

/**
 * THE registry instance. magica-durable adds [cropImageTool, gptImage2Tool, mergeVideosTool] here.
 * Skill tools come from the agent-engine slice via createSkillTools.
 */
function skillTools() {
  try {
    return createSkillTools(getSkillRegistry());
  } catch {
    return []; // registry not implemented yet in this worktree
  }
}

export const toolRegistry = new ToolRegistry([...skillTools()]);
