import type { SkillDescriptor } from "@agent-chat/contracts";
import type { LoadedSkill, SkillAsset, SkillRegistry } from "@/agent/skills/types";

export function makeFakeSkillRegistry(skills: LoadedSkill[] = [], assets: Record<string, SkillAsset> = {}): SkillRegistry & { skills: Map<string, LoadedSkill> } {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    skills: byName,
    list(): SkillDescriptor[] {
      return [...byName.values()].map(({ body: _body, dir: _dir, ...rest }) => rest);
    },
    get(name: string) {
      return byName.get(name);
    },
    async readAsset(name: string, rel: string): Promise<SkillAsset> {
      const asset = assets[`${name}:${rel}`];
      if (!asset) throw new Error(`no fake asset configured for ${name}:${rel}`);
      return asset;
    },
    promptIndex(): string {
      return ["Skills available via load_skill:", ...[...byName.values()].map((s) => `- ${s.name}: ${s.description}`).sort()].join("\n");
    },
  };
}
