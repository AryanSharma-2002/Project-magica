import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillRegistry } from "@/agent/skills/registry";

function mkSkill(root: string, dir: string, frontmatter: string, body: string, files: Record<string, string> = {}): void {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(full, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
}

describe("skill registry", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scans a valid skill with assets and computes a stable content hash", async () => {
    mkSkill(root, "great-skill", 'name: great-skill\ndescription: Does great things\nversion: "1.0.0"', "# Great skill\n\nBody text.", {
      "notes.md": "asset content",
    });
    const registry = await createSkillRegistry({ roots: [root] });
    expect(registry.issues()).toEqual([]);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "great-skill", description: "Does great things", version: "1.0.0", assets: ["notes.md"] });
    expect(list[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const loaded = registry.get("great-skill");
    expect(loaded?.body).toBe("# Great skill\n\nBody text.");

    const asset = await registry.readAsset("great-skill", "notes.md");
    expect(asset.content).toBe("asset content");
    expect(asset.mimeType).toBe("text/markdown");
    expect(asset.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("promptIndex lists skills sorted by name with descriptions", async () => {
    mkSkill(root, "zeta", "name: zeta\ndescription: Z thing", "body");
    mkSkill(root, "alpha", "name: alpha\ndescription: A thing", "body");
    const registry = await createSkillRegistry({ roots: [root] });
    const index = registry.promptIndex();
    const lines = index.split("\n");
    expect(lines[0]).toMatch(/load_skill/);
    expect(lines.slice(1)).toEqual(["- alpha: A thing", "- zeta: Z thing"]);
  });

  it("skips malformed frontmatter", async () => {
    mkSkill(root, "bad-fm", "description: missing name field", "body");
    const registry = await createSkillRegistry({ roots: [root] });
    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toEqual([{ dir: path.join(root, "bad-fm"), reason: "invalid_frontmatter" }]);
  });

  it("skips a name/directory mismatch", async () => {
    mkSkill(root, "actual-dir", "name: different-name\ndescription: x", "body");
    const registry = await createSkillRegistry({ roots: [root] });
    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toEqual([{ dir: path.join(root, "actual-dir"), reason: "name_mismatch" }]);
  });

  it("keeps the first of duplicate names (across roots, first root wins) and flags the rest", async () => {
    const rootB = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "skills-test-b-"));
    try {
      mkSkill(root, "dup", "name: dup\ndescription: first", "body one");
      mkSkill(rootB, "dup", "name: dup\ndescription: second", "body two");
      const registry = await createSkillRegistry({ roots: [root, rootB] });
      expect(registry.list()).toHaveLength(1);
      expect(registry.get("dup")?.description).toBe("first");
      expect(registry.issues()).toContainEqual({ dir: path.join(rootB, "dup"), reason: "duplicate_name" });
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("skips a directory with no SKILL.md", async () => {
    fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });
    const registry = await createSkillRegistry({ roots: [root] });
    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toEqual([{ dir: path.join(root, "empty-dir"), reason: "missing_skill_md" }]);
  });

  it("rejects an oversized SKILL.md", async () => {
    mkSkill(root, "huge", "name: huge\ndescription: x", "y".repeat(70_000));
    const registry = await createSkillRegistry({ roots: [root], maxFileBytes: 1024 });
    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toEqual([{ dir: path.join(root, "huge"), reason: "too_large" }]);
  });

  it("excludes an oversized asset from the assets list without failing the skill", async () => {
    mkSkill(root, "with-big-asset", "name: with-big-asset\ndescription: x", "body", { "big.md": "z".repeat(2000) });
    const registry = await createSkillRegistry({ roots: [root], maxFileBytes: 1024 });
    expect(registry.issues()).toEqual([]);
    expect(registry.get("with-big-asset")?.assets).toEqual([]);
  });

  it("excludes an asset with an unsupported extension from the assets list", async () => {
    mkSkill(root, "with-exe", "name: with-exe\ndescription: x", "body", { "script.exe": "binary" });
    const registry = await createSkillRegistry({ roots: [root] });
    expect(registry.get("with-exe")?.assets).toEqual([]);
  });

  it("rejects path traversal on readAsset", async () => {
    mkSkill(root, "trav", "name: trav\ndescription: x", "body", { "safe.md": "ok" });
    fs.writeFileSync(path.join(root, "secret.md"), "top secret", "utf8");
    const registry = await createSkillRegistry({ roots: [root] });
    await expect(registry.readAsset("trav", "../secret.md")).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects an absolute path on readAsset", async () => {
    mkSkill(root, "abs", "name: abs\ndescription: x", "body", { "safe.md": "ok" });
    const registry = await createSkillRegistry({ roots: [root] });
    await expect(registry.readAsset("abs", path.join(root, "abs", "safe.md"))).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects a symlink that resolves outside the skill directory", async () => {
    mkSkill(root, "linked", "name: linked\ndescription: x", "body");
    fs.writeFileSync(path.join(root, "outside.md"), "outside content", "utf8");
    fs.symlinkSync(path.join(root, "outside.md"), path.join(root, "linked", "escape.md"));
    const registry = await createSkillRegistry({ roots: [root] });
    await expect(registry.readAsset("linked", "escape.md")).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects an unsupported extension on readAsset", async () => {
    mkSkill(root, "ext", "name: ext\ndescription: x", "body");
    fs.writeFileSync(path.join(root, "ext", "notes.exe"), "binary", "utf8");
    const registry = await createSkillRegistry({ roots: [root] });
    await expect(registry.readAsset("ext", "notes.exe")).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects an oversized asset on readAsset", async () => {
    mkSkill(root, "size", "name: size\ndescription: x", "body");
    fs.writeFileSync(path.join(root, "size", "notes.md"), "y".repeat(2000), "utf8");
    const registry = await createSkillRegistry({ roots: [root], maxFileBytes: 1024 });
    await expect(registry.readAsset("size", "notes.md")).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects reading an asset for an unknown skill", async () => {
    const registry = await createSkillRegistry({ roots: [root] });
    await expect(registry.readAsset("nope", "x.md")).rejects.toMatchObject({ code: "validation_error" });
  });

  it("returns an empty registry when the root does not exist", async () => {
    const registry = await createSkillRegistry({ roots: [path.join(root, "does-not-exist")] });
    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toEqual([]);
  });
});
