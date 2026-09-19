import { z } from "zod";
import { ToolDescriptor, type ToolName } from "@agent-chat/contracts";
import type { AnyToolDefinition } from "./types";
import { AppError } from "@/lib/errors";

/** Provider-neutral tool spec handed to the LLM adapter (OpenAI-compatible function shape). */
export type ProviderToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

/**
 * Single source of truth for tool discovery, validation, estimation, execution dispatch and
 * result rendering metadata. Adding a tool = add a file under src/agent/tools/definitions and
 * list it in src/agent/tools/index.ts. Nothing else changes.
 */
export class ToolRegistry {
  private readonly byName = new Map<ToolName, AnyToolDefinition>();
  private readonly resolvedInput = new Map<ToolName, { schema: z.ZodType; at: number }>();
  private static readonly RESOLVE_TTL_MS = 10 * 60 * 1000;

  constructor(tools: ReadonlyArray<AnyToolDefinition>) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  list(): AnyToolDefinition[] {
    return [...this.byName.values()];
  }

  get(name: string): AnyToolDefinition {
    const t = this.byName.get(name as ToolName);
    if (!t) throw new AppError("malformed_tool_call", `Unknown tool: ${name}`, { details: { toolName: name } });
    return t;
  }

  has(name: string): boolean {
    return this.byName.has(name as ToolName);
  }

  /** Input schema, refreshed from the provider catalog when the tool supports it. */
  async inputSchema(name: ToolName): Promise<z.ZodType> {
    const tool = this.get(name);
    if (!tool.resolveInputSchema) return tool.input;
    const cached = this.resolvedInput.get(name);
    if (cached && Date.now() - cached.at < ToolRegistry.RESOLVE_TTL_MS) return cached.schema;
    try {
      const schema = await tool.resolveInputSchema();
      this.resolvedInput.set(name, { schema, at: Date.now() });
      return schema;
    } catch {
      return cached?.schema ?? tool.input; // provider catalog down: fall back to baseline contract
    }
  }

  /** Validate raw model-provided arguments. Throws AppError(malformed_tool_call) with issues. */
  async parseInput(name: ToolName, raw: unknown): Promise<unknown> {
    const schema = await this.inputSchema(name);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("malformed_tool_call", `Invalid input for tool ${name}`, {
        details: { toolName: name, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    return parsed.data;
  }

  parseOutput(name: ToolName, raw: unknown): unknown {
    const parsed = this.get(name).output.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("provider_error", `Tool ${name} returned an unexpected result`, {
        retryable: true,
        details: { toolName: name, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    return parsed.data;
  }

  async toProviderTools(): Promise<ProviderToolSpec[]> {
    const specs: ProviderToolSpec[] = [];
    for (const t of this.list()) {
      const schema = await this.inputSchema(t.name);
      specs.push({ name: t.name, description: t.description, parameters: toJsonSchema(schema) });
    }
    return specs;
  }

  async toDescriptors(): Promise<ToolDescriptor[]> {
    const out: ToolDescriptor[] = [];
    for (const t of this.list()) {
      out.push(
        ToolDescriptor.parse({
          name: t.name,
          label: t.label,
          description: t.description,
          group: t.group,
          creditModel: t.creditModel,
          requiresApproval: t.requiresApproval,
          execution: t.execution,
          inputSchema: toJsonSchema(await this.inputSchema(t.name)),
          outputSchema: toJsonSchema(t.output),
        }),
      );
    }
    return out;
  }
}

/** JSON Schema for LLM function parameters; `io: "input"` keeps `.default()` fields optional. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-7" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}
