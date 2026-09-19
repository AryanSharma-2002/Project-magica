import { z } from "zod";
import { Id, IsoDate, JsonValue, Microcredits } from "./primitives";
import { SafeError } from "./errors";
import { AttachmentKind } from "./enums";

/**
 * Content blocks are the ONLY persisted message body shape (Message.content JSONB = ContentBlock[]).
 * Ordering is by array position. Every block emitted during a run carries the same `index`
 * in realtime metadata/streams so the live view and the persisted view reconcile 1:1.
 */

export const TextBlock = z.object({ type: z.literal("text"), text: z.string() });

/** Provider reasoning tokens (collapsible in UI, shows duration). */
export const ThinkingBlock = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
});

/** Short agent step narration ("Cropping the generated image…"). */
export const ReasoningBlock = z.object({ type: z.literal("reasoning"), text: z.string().max(2000) });

export const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  toolCallId: z.string().max(128),
  invocationId: Id,
  toolName: z.string().max(64),
  /** Sanitized input: never contains provider keys; large payloads are truncated server-side. */
  input: JsonValue,
});

export const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string().max(128),
  invocationId: Id,
  toolName: z.string().max(64),
  status: z.enum(["completed", "failed", "cancelled"]),
  output: JsonValue.optional(),
  error: SafeError.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  microcredits: Microcredits.optional(),
});

export const CitationBlock = z.object({
  type: z.literal("citation"),
  url: z.string().url(),
  title: z.string().max(300).optional(),
  snippet: z.string().max(1000).optional(),
});

export const UsageBlock = z.object({
  type: z.literal("usage"),
  /** Actual routed model reported by OpenRouter (e.g. "upstage/solar-pro-3:free"). */
  model: z.string().max(200),
  requestedModel: z.string().max(200),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Always 0 for OpenRouter Free; tool charges are on ToolResultBlock. */
  microcredits: Microcredits,
});

/** A generated media output. Also persisted as an Attachment(source="generated"). */
export const AssetBlock = z.object({
  type: z.literal("asset"),
  kind: AttachmentKind,
  url: z.string().url(),
  attachmentId: Id.optional(),
  toolCallId: z.string().max(128).optional(),
  mimeType: z.string().max(100).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  expiresAt: IsoDate.optional(),
});

export const ErrorBlock = z.object({ type: z.literal("error"), error: SafeError });

export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ThinkingBlock,
  ReasoningBlock,
  ToolUseBlock,
  ToolResultBlock,
  CitationBlock,
  UsageBlock,
  AssetBlock,
  ErrorBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export type ContentBlockType = ContentBlock["type"];

export const ContentBlocks = z.array(ContentBlock).max(2000);
export type ContentBlocks = z.infer<typeof ContentBlocks>;

export type TextBlock = z.infer<typeof TextBlock>;
export type ThinkingBlock = z.infer<typeof ThinkingBlock>;
export type ReasoningBlock = z.infer<typeof ReasoningBlock>;
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;
export type CitationBlock = z.infer<typeof CitationBlock>;
export type UsageBlock = z.infer<typeof UsageBlock>;
export type AssetBlock = z.infer<typeof AssetBlock>;
export type ErrorBlock = z.infer<typeof ErrorBlock>;

/** Plain-text projection used for search indexing and previews. */
export function blocksToPlainText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
