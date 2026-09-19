import path from "node:path";
import { createSkillRegistrySync } from "./registry";
import type { SkillRegistry } from "./types";

/**
 * Skill registry singleton (agent-engine slice): scans <repo>/agent-skills at first access.
 * Synchronous by design: src/agent/tools/index.ts (read-only, backend-core spine) calls this
 * directly inside a try/catch with no await, so it must never return a Promise or throw for the
 * common "no skills yet" case (missing root scans to zero skills, not an error).
 */
let singleton: SkillRegistry | undefined;

export function getSkillRegistry(): SkillRegistry {
  if (!singleton) {
    singleton = createSkillRegistrySync({ roots: [path.join(process.cwd(), "agent-skills")] });
  }
  return singleton;
}

/** Test-only: force a re-scan on the next getSkillRegistry() call. */
export function __resetSkillRegistryForTests(): void {
  singleton = undefined;
}
