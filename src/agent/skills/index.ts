import type { SkillRegistry } from "./types";

/** Skill registry singleton (agent-engine slice): scans <repo>/agent-skills at first access. */
export function getSkillRegistry(): SkillRegistry {
  throw new Error("skill registry not implemented");
}
