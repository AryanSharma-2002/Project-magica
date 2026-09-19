import { ToolRegistry } from "./registry";

/**
 * THE registry instance (magica-durable slice composes it):
 *   new ToolRegistry([cropImageTool, gptImage2Tool, mergeVideosTool, ...createSkillTools(skillRegistry)])
 */
export const toolRegistry = new ToolRegistry([]);
