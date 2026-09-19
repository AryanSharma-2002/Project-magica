import { ToolRegistry } from "./registry";
import type { AnyToolDefinition } from "./types";
import { createSkillTools } from "@/agent/skills/tools";
import { getSkillRegistry } from "@/agent/skills";
import { cropImageTool } from "./definitions/crop-image";
import { gptImage2Tool } from "./definitions/gpt-image-2";
import { mergeVideosTool } from "./definitions/merge-videos";

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

// Concrete tool definitions are intentionally strongly-typed (see defineTool's doc comment in
// ./types.ts: "preserves inference of I/O types", which is what makes each definition file's own
// unit tests useful). ToolRegistry is a heterogeneous collection keyed by runtime name + Zod
// validation, so widening to AnyToolDefinition here (rather than weakening every tool file's
// exported type) is the correct place for the erasure: registry.parseInput() validates raw
// arguments against each tool's own schema before estimate/execute ever see them, so the
// contravariant parameter narrowing this cast papers over is sound in practice.
export const toolRegistry = new ToolRegistry([
  cropImageTool as AnyToolDefinition,
  gptImage2Tool as AnyToolDefinition,
  mergeVideosTool as AnyToolDefinition,
  ...skillTools(),
]);
