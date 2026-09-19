import type { AppLimits, Attachment } from "@agent-chat/contracts";
import type { SkillRegistry } from "@/agent/skills/types";

export type LoadedSkillForPrompt = { name: string; body: string };

export type BuildSystemPromptArgs = {
  skills: SkillRegistry;
  limits: AppLimits;
  now: Date;
  /** READY attachments of the current user message. */
  attachments: ReadonlyArray<Pick<Attachment, "kind" | "url">>;
  planMode: boolean;
  /** Skills already loaded earlier in this run (restore on retry/resume): full bodies, fetched
   * from the registry so a resumed run sees the same guidance it saw before. */
  loadedSkills?: ReadonlyArray<LoadedSkillForPrompt>;
};

/** Builds the system prompt: persona, tool policy, skill index, date, attachments, plan-mode note. */
export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const lines: string[] = [];

  lines.push(
    "You are the Galaxy agent, an assistant that helps users generate, crop, and merge media (images and video) using a fixed set of tools.",
  );
  lines.push("");
  lines.push(`Current date: ${args.now.toISOString()}`);
  lines.push("");
  lines.push("Tool policy:");
  lines.push("- Only call a tool when the user is asking for media work (generating, cropping, or merging images/video).");
  lines.push("- Chain tool calls when a request needs more than one step (e.g. generate an image, then crop it).");
  lines.push("- Never invent a URL. Only use an attachment URL listed below, or a URL returned by an earlier tool call in this turn.");
  lines.push("- Call load_skill before configuring a media tool you're unsure how to use correctly; call it only when it is relevant to the current step.");
  lines.push("");
  lines.push(args.skills.promptIndex());

  if (args.attachments.length > 0) {
    lines.push("");
    lines.push("Attachments available in this turn:");
    for (const a of args.attachments) lines.push(`- ${a.kind}: ${a.url}`);
  } else {
    lines.push("");
    lines.push("No attachments are available in this turn.");
  }

  if (args.loadedSkills && args.loadedSkills.length > 0) {
    lines.push("");
    lines.push("Guidance already loaded earlier in this run (do not call load_skill again for these unless you need a different asset):");
    for (const skill of args.loadedSkills) {
      lines.push("");
      lines.push(`--- ${skill.name} ---`);
      lines.push(skill.body);
    }
  }

  if (args.planMode) {
    lines.push("");
    lines.push(
      "Plan mode is ON: before your first batch of tool calls runs, the user will be shown a plan derived from those calls and must approve it. Propose tool calls normally; there is no separate plan-writing step.",
    );
  }

  lines.push("");
  lines.push(`Limits: at most ${args.limits.maxToolCallsPerTurn} tool calls per response, at most ${args.limits.maxTurnsPerRun} model turns per run.`);

  return lines.join("\n");
}
