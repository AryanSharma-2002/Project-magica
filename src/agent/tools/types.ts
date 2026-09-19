import type { z } from "zod";
import type { AssetBlock, CreditModel, JsonValue, ToolDescriptor, ToolGroup, ToolName } from "@agent-chat/contracts";
import type { Logger } from "@/lib/logger";

/**
 * A tool is a typed contract: Zod input -> execute -> Zod output.
 * Tools NEVER touch chat state, credits, or messages. Orchestration owns side effects.
 */

export type ToolContext = {
  userId: string;
  runId: string | null;
  chatId: string | null;
  invocationId: string;
  toolCallId: string;
  /** Cooperative cancellation (run cancelled, waitpoint expired, etc.) */
  signal: AbortSignal;
  log: Logger;
  /** Progress reporter (0..1, optional label) -> surfaced in realtime metadata by the orchestrator */
  onProgress?: (progress: number, label?: string) => void;
  /** Ready user attachments for this turn, for tools that accept media */
  attachments: ReadonlyArray<{ id: string; kind: string; url: string; mimeType: string }>;
  /** Provider-side run id already persisted for this invocation (resume: poll instead of re-submitting). */
  existingProviderRunId?: string | null;
  /** Called the instant a provider run id is known so orchestration can persist it for reconciliation. */
  onProviderRunId?: (providerRunId: string) => Promise<void> | void;
};

export type ToolEffect =
  | { type: "asset"; asset: Omit<AssetBlock, "type" | "attachmentId"> }
  | { type: "record_skill"; skillName: string; assetPath: string; contentHash: string };

export type ToolExecutionResult<O> = {
  output: O;
  /** Provider-side run id for reconciliation (Magica runId) */
  providerRunId?: string;
  /** Actual settled cost in microcredits (0 when free/unknown) */
  microcreditsCharged: number;
  durationMs: number;
};

export type ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: ToolName;
  label: string;
  description: string;
  group: ToolGroup;
  input: I;
  output: O;
  creditModel: CreditModel;
  requiresApproval: ToolDescriptor["requiresApproval"];
  /** inline = run in the orchestrator process; durable_child_task = run in a Trigger.dev child task with idempotencyKey = invocationId */
  execution: ToolDescriptor["execution"];
  /** Optional: replace/refine the input schema from a live provider catalog (gpt_image_2). Cached by the caller. */
  resolveInputSchema?: () => Promise<I>;
  /** Estimated microcredits BEFORE execution (used for reservation + approval threshold). */
  estimate: (input: z.output<I>, ctx: ToolContext) => Promise<number>;
  execute: (input: z.output<I>, ctx: ToolContext) => Promise<ToolExecutionResult<z.output<O>>>;
  /**
   * Declarative side effects derived from a successful output. Orchestration applies them
   * (persist Attachments + asset blocks, record RunSkill). Tools never write to the DB themselves.
   */
  effects?: (output: z.output<O>, ctx: ToolContext) => ToolEffect[];
  /** Redact/trim input before it is persisted or echoed to the model. Default: identity. */
  sanitizeInput?: (input: z.output<I>) => JsonValue;
};

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;

/** Identity helper that preserves inference of I/O types. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}
