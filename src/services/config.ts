import { AppConfig, AppLimits, DEFAULT_LIMITS, type SkillDescriptor } from "@agent-chat/contracts";
import { getEnv } from "@/lib/env";
import { toolRegistry } from "@/agent/tools";
import { getSkillRegistry } from "@/agent/skills";

/** Effective limits: DEFAULT_LIMITS overridden by env. Shared with send.ts (admission reservation, attachment checks). */
export function getLimits(): AppLimits {
  const env = getEnv();
  return {
    ...DEFAULT_LIMITS,
    admissionMicrocredits: env.ADMISSION_MICROCREDITS,
    approvalThresholdMicrocredits: env.APPROVAL_THRESHOLD_MICROCREDITS,
  };
}

/** `GET /api/v1/config`: limits/models/tools/skills are backend-owned; the frontend never hardcodes them. */
export async function getConfig(): Promise<AppConfig> {
  const limits = getLimits();
  const models = [
    { id: "openrouter/free" as const, label: "OpenRouter Free", provider: "openrouter" as const, free: true as const, status: "unknown" as const },
  ];
  const tools = await toolRegistry.toDescriptors();

  // The skill registry is implemented by another slice; until it is, treat it as empty.
  let skills: SkillDescriptor[];
  try {
    skills = getSkillRegistry().list();
  } catch {
    skills = [];
  }

  return AppConfig.parse({ limits, models, tools, skills });
}
