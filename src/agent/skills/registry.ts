import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";
import type { SkillDescriptor } from "@agent-chat/contracts";
import { SkillName } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { LoadedSkill, SkillAsset, SkillRegistry, SkillRegistryOptions, SkillValidationIssue } from "./types";

/** Default bound on SKILL.md and every asset file (bytes). */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
/** Default allowed asset extensions (lowercase, with leading dot). */
const DEFAULT_ALLOWED_EXTENSIONS = [".md", ".txt", ".json", ".yaml", ".yml", ".csv"];
/** LoadSkillOutput.body / ReadSkillAssetOutput.content are capped at 64_000 chars by the contract,
 * which is stricter than the default 64 KiB byte cap for non-ASCII content. Enforce both. */
const MAX_CONTENT_CHARS = 64_000;

const SkillFrontmatter = z.object({
  name: SkillName,
  description: z.string().min(1).max(500),
  version: z.string().max(32).optional(),
});

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
};

export interface SkillRegistryWithIssues extends SkillRegistry {
  /** Skills skipped at scan time, for diagnostics/logging. */
  issues(): SkillValidationIssue[];
}

type NormalizedOptions = { roots: string[]; maxFileBytes: number; allowedExtensions: string[] };

function normalizeOptions(opts: SkillRegistryOptions): NormalizedOptions {
  return {
    roots: opts.roots,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    allowedExtensions: opts.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS,
  };
}

function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function toDescriptor(skill: LoadedSkill): SkillDescriptor {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.version !== undefined ? { version: skill.version } : {}),
    assets: skill.assets,
    contentHash: skill.contentHash,
  };
}

/** Recursively collects allowed asset files under `dir`. Skips symlinks (readAsset re-verifies at read time),
 * excludes SKILL.md, excludes disallowed extensions. Oversized files are silently excluded (not fatal to the
 * skill) since they would simply fail the read-time size check anyway. */
function collectAssets(dir: string, allowedExtensions: string[], maxFileBytes: number): string[] {
  const result: string[] = [];
  const walk = (current: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel === "SKILL.md") continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.includes(ext)) continue;
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > maxFileBytes) continue;
      result.push(rel);
    }
  };
  walk(dir, "");
  return result.sort();
}

function scanSkillsSync(opts: NormalizedOptions): { skills: Map<string, LoadedSkill>; issues: SkillValidationIssue[] } {
  const skills = new Map<string, LoadedSkill>();
  const issues: SkillValidationIssue[] = [];

  for (const root of opts.roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root does not exist: no skills from it, not an error
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.resolve(root, entry.name);
      const skillMdPath = path.join(dirPath, "SKILL.md");

      let stat: fs.Stats;
      try {
        stat = fs.statSync(skillMdPath);
        if (!stat.isFile()) throw new Error("not a file");
      } catch {
        issues.push({ dir: dirPath, reason: "missing_skill_md" });
        continue;
      }
      if (stat.size > opts.maxFileBytes) {
        issues.push({ dir: dirPath, reason: "too_large" });
        continue;
      }

      let raw: string;
      try {
        raw = fs.readFileSync(skillMdPath, "utf8");
      } catch {
        issues.push({ dir: dirPath, reason: "invalid_frontmatter" });
        continue;
      }

      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(raw);
      } catch {
        issues.push({ dir: dirPath, reason: "invalid_frontmatter" });
        continue;
      }

      const fm = SkillFrontmatter.safeParse(parsed.data);
      if (!fm.success) {
        issues.push({ dir: dirPath, reason: "invalid_frontmatter" });
        continue;
      }
      if (fm.data.name !== entry.name) {
        issues.push({ dir: dirPath, reason: "name_mismatch" });
        continue;
      }
      if (skills.has(fm.data.name)) {
        issues.push({ dir: dirPath, reason: "duplicate_name" });
        continue;
      }

      const body = parsed.content.trim();
      if (Buffer.byteLength(body, "utf8") > opts.maxFileBytes || body.length > MAX_CONTENT_CHARS) {
        issues.push({ dir: dirPath, reason: "too_large" });
        continue;
      }

      const contentHash = sha256Hex(body);
      let realDir: string;
      try {
        realDir = fs.realpathSync(dirPath);
      } catch {
        issues.push({ dir: dirPath, reason: "missing_skill_md" });
        continue;
      }
      const assets = collectAssets(realDir, opts.allowedExtensions, opts.maxFileBytes);

      skills.set(fm.data.name, {
        name: fm.data.name,
        description: fm.data.description,
        ...(fm.data.version !== undefined ? { version: fm.data.version } : {}),
        assets,
        contentHash,
        body,
        dir: realDir,
      });
    }
  }

  return { skills, issues };
}

class SkillRegistryImpl implements SkillRegistryWithIssues {
  constructor(
    private readonly skills: Map<string, LoadedSkill>,
    private readonly scanIssues: SkillValidationIssue[],
    private readonly opts: NormalizedOptions,
  ) {}

  list(): SkillDescriptor[] {
    return [...this.skills.values()].map(toDescriptor);
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  async readAsset(name: string, relativePath: string): Promise<SkillAsset> {
    const skill = this.skills.get(name);
    if (!skill) throw new AppError("validation_error", "Unknown skill", { details: { name } });

    if (path.isAbsolute(relativePath)) {
      throw new AppError("validation_error", "Asset path must be relative", { details: { name, path: relativePath } });
    }
    const normalized = path.normalize(relativePath);
    if (normalized.split(path.sep).includes("..")) {
      throw new AppError("validation_error", "Asset path may not traverse directories", { details: { name, path: relativePath } });
    }
    const ext = path.extname(normalized).toLowerCase();
    if (!this.opts.allowedExtensions.includes(ext)) {
      throw new AppError("validation_error", "Unsupported asset extension", { details: { name, path: relativePath } });
    }

    const resolved = path.resolve(skill.dir, normalized);
    if (resolved !== skill.dir && !resolved.startsWith(skill.dir + path.sep)) {
      throw new AppError("validation_error", "Asset path escapes the skill directory", { details: { name, path: relativePath } });
    }

    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(resolved);
    } catch {
      throw new AppError("not_found", "Asset not found", { details: { name, path: relativePath } });
    }
    if (lst.isSymbolicLink()) {
      let real: string;
      try {
        real = await fs.promises.realpath(resolved);
      } catch {
        throw new AppError("not_found", "Asset not found", { details: { name, path: relativePath } });
      }
      if (real !== skill.dir && !real.startsWith(skill.dir + path.sep)) {
        throw new AppError("validation_error", "Asset symlink escapes the skill directory", { details: { name, path: relativePath } });
      }
    } else if (!lst.isFile()) {
      throw new AppError("not_found", "Asset not found", { details: { name, path: relativePath } });
    }

    const finalStat = fs.statSync(resolved);
    if (finalStat.size > this.opts.maxFileBytes) {
      throw new AppError("validation_error", "Asset exceeds the maximum file size", { details: { name, path: relativePath } });
    }

    const content = fs.readFileSync(resolved, "utf8");
    if (content.length > MAX_CONTENT_CHARS) {
      throw new AppError("validation_error", "Asset content exceeds the maximum size", { details: { name, path: relativePath } });
    }

    const relNormalized = path.relative(skill.dir, resolved).split(path.sep).join("/");
    return {
      path: relNormalized,
      mimeType: MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
      content,
      contentHash: sha256Hex(content),
    };
  }

  promptIndex(): string {
    const lines = this.list()
      .map((s) => `- ${s.name}: ${s.description}`)
      .sort();
    return ["Skills available via load_skill (call it only when relevant to the current task):", ...lines].join("\n");
  }

  issues(): SkillValidationIssue[] {
    return this.scanIssues;
  }
}

function logIssues(issues: SkillValidationIssue[]): void {
  if (issues.length === 0) return;
  const log = logger();
  for (const issue of issues) {
    log.warn({ skillDir: issue.dir, reason: issue.reason }, "skill validation issue: skill skipped");
  }
}

/** Async scan (per SkillRegistryOptions). The underlying scan is synchronous fs I/O; this wraps it
 * so callers who want to `await` scan completion (e.g. tests, explicit init) can do so. */
export async function createSkillRegistry(opts: SkillRegistryOptions): Promise<SkillRegistryWithIssues> {
  const normalized = normalizeOptions(opts);
  const { skills, issues } = scanSkillsSync(normalized);
  logIssues(issues);
  return new SkillRegistryImpl(skills, issues, normalized);
}

/** Synchronous variant used by the memoized singleton (src/agent/skills/index.ts), which must not
 * be async because it is called synchronously from src/agent/tools/index.ts. */
export function createSkillRegistrySync(opts: SkillRegistryOptions): SkillRegistryWithIssues {
  const normalized = normalizeOptions(opts);
  const { skills, issues } = scanSkillsSync(normalized);
  logIssues(issues);
  return new SkillRegistryImpl(skills, issues, normalized);
}
