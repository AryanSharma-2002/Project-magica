import type { SkillDescriptor } from "@agent-chat/contracts";

/**
 * Skills = versioned, on-demand guidance stored at agent-skills/<name>/SKILL.md (YAML frontmatter: name, description[, version]).
 * The base prompt only receives names + descriptions. Bodies/assets are fetched through the typed
 * load_skill / read_skill_asset tools and recorded on the run (RunSkill) with a content hash.
 */
export type LoadedSkill = SkillDescriptor & {
  /** Markdown body without frontmatter */
  body: string;
  /** Absolute, normalized directory; asset reads must stay inside it. */
  dir: string;
};

export type SkillAsset = { path: string; mimeType: string; content: string; contentHash: string };

export type SkillRegistryOptions = {
  /** Approved roots to scan. Default: [<repo>/agent-skills] */
  roots: string[];
  /** Max SKILL.md / asset size in bytes. Default 64 KiB. */
  maxFileBytes?: number;
  /** Allowed asset extensions. Default: .md .txt .json .yaml .yml .csv */
  allowedExtensions?: string[];
};

export interface SkillRegistry {
  /** Names + descriptions only — safe to put in the base prompt. */
  list(): SkillDescriptor[];
  get(name: string): LoadedSkill | undefined;
  /** Rejects traversal, symlinks escaping the dir, unsupported extensions, oversized files. */
  readAsset(name: string, relativePath: string): Promise<SkillAsset>;
  /** Rendered block for the system prompt. */
  promptIndex(): string;
}

/** Problems found at scan time; the registry logs and skips the offending skill. */
export type SkillValidationIssue = { dir: string; reason: "missing_skill_md" | "invalid_frontmatter" | "duplicate_name" | "too_large" | "name_mismatch" };
