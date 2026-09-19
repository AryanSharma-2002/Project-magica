import { z } from "zod";
import type { JsonValue, ToolName } from "@agent-chat/contracts";
import { ToolRegistry } from "@/agent/tools/registry";
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolEffect, type ToolExecutionResult } from "@/agent/tools/types";

export const TestInput = z.object({ value: z.number().default(1) });
export const TestOutput = z.object({ result: z.number() });
export type TestInput = z.infer<typeof TestInput>;
export type TestOutput = z.infer<typeof TestOutput>;

export type TestToolOptions = {
  name: ToolName;
  label?: string;
  estimate?: number;
  requiresApproval?: "never" | "above_threshold" | "always";
  execution?: "inline" | "durable_child_task";
  execute?: (input: TestInput, ctx: ToolContext) => Promise<ToolExecutionResult<TestOutput>>;
  effects?: (output: TestOutput, ctx: ToolContext) => ToolEffect[];
  sanitizeInput?: (input: TestInput) => Record<string, JsonValue>;
};

/** Reuses one of the closed ToolName values (crop_image / gpt_image_2 / merge_videos) with a
 * simple test-only schema, since ToolDefinition.name is constrained to the contract's ToolName union. */
export function makeTestTool(opts: TestToolOptions): AnyToolDefinition {
  const estimate = opts.estimate ?? 1000;
  const def = defineTool({
    name: opts.name,
    label: opts.label ?? opts.name,
    description: "test tool",
    group: "media",
    input: TestInput,
    output: TestOutput,
    creditModel: { type: "per_item", microcredits: estimate },
    requiresApproval: opts.requiresApproval ?? "never",
    execution: opts.execution ?? "inline",
    estimate: async () => estimate,
    execute: opts.execute ?? (async (input) => ({ output: { result: input.value * 2 }, microcreditsCharged: estimate, durationMs: 5 })),
    ...(opts.effects ? { effects: opts.effects } : {}),
    ...(opts.sanitizeInput ? { sanitizeInput: opts.sanitizeInput } : {}),
  });
  return def as unknown as AnyToolDefinition;
}

export function makeThrowingTool(opts: { name: ToolName; error?: unknown; requiresApproval?: "never" | "above_threshold" | "always"; estimate?: number }): AnyToolDefinition {
  return makeTestTool({
    name: opts.name,
    ...(opts.estimate !== undefined ? { estimate: opts.estimate } : {}),
    ...(opts.requiresApproval !== undefined ? { requiresApproval: opts.requiresApproval } : {}),
    execute: async () => {
      throw opts.error ?? new Error("boom");
    },
  });
}

export function buildTestRegistry(tools: AnyToolDefinition[]): ToolRegistry {
  return new ToolRegistry(tools);
}
