import { z } from "zod";
import { Id, IsoDate, Microcredits } from "./primitives";
import { RunStatus, ToolInvocationStatus, WaitpointStatus, WaitpointType } from "./enums";
import { SafeError } from "./errors";
import { AssetBlock } from "./blocks";

/**
 * Realtime is TRANSPORT ONLY. PostgreSQL is the source of truth.
 * Two channels per run:
 *  1) Trigger.dev run metadata  -> RunMetadata (status, step, tools, waitpoint, assets)  [<= 256KB]
 *  2) Trigger.dev typed stream  -> TextChunk (token deltas for text/thinking blocks)  [stream id: AGENT_TEXT_STREAM_ID]
 * Both carry `index` = position of the block in the assistant message's content array.
 */

export const AGENT_TEXT_STREAM_ID = "agent-text" as const;
export const RUN_METADATA_VERSION = 1 as const;

export const TextChunk = z.object({
  /** text or thinking token delta */
  t: z.enum(["text", "thinking"]),
  /** content block index in the assistant message */
  i: z.number().int().nonnegative(),
  /** delta */
  d: z.string(),
});
export type TextChunk = z.infer<typeof TextChunk>;

export const LiveToolState = z.object({
  invocationId: Id,
  toolName: z.string().max(64),
  status: ToolInvocationStatus,
  /** content block index of the tool_use block */
  index: z.number().int().nonnegative(),
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  microcredits: Microcredits.optional(),
  providerRunId: z.string().max(128).nullable(),
  error: SafeError.nullable(),
});
export type LiveToolState = z.infer<typeof LiveToolState>;

export const LiveWaitpoint = z.object({
  id: Id,
  type: WaitpointType,
  status: WaitpointStatus,
  expiresAt: IsoDate,
});

export const RunMetadata = z.object({
  v: z.literal(RUN_METADATA_VERSION),
  runId: Id,
  chatId: Id,
  assistantMessageId: Id,
  status: RunStatus,
  /** Human-readable current step for the streaming bubble ("Thinking", "Generating image…"). */
  step: z.string().max(200).nullable(),
  progress: z.number().min(0).max(1).nullable(),
  thinkingStartedAt: IsoDate.nullable(),
  thinkingMs: z.number().int().nonnegative().nullable(),
  routedModel: z.string().max(200).nullable(),
  /** keyed by toolCallId */
  tools: z.record(z.string(), LiveToolState),
  waitpoint: LiveWaitpoint.nullable(),
  /** Generated assets so far, with their block index; bounded to the last 20. */
  assets: z.array(AssetBlock.extend({ index: z.number().int().nonnegative() })).max(20),
  /** Block indices that hold a `reasoning` narration and its text (bounded). */
  reasoning: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string().max(2000) })).max(50),
  error: SafeError.nullable(),
  /** Highest block index already checkpointed to PostgreSQL. */
  persistedUpTo: z.number().int().min(-1),
  updatedAt: IsoDate,
});
export type RunMetadata = z.infer<typeof RunMetadata>;

/** Returned by send and by POST /runs/:id/realtime-token. */
export const RealtimeAccess = z.object({
  triggerRunId: z.string().max(128),
  publicAccessToken: z.string(),
  expiresAt: IsoDate,
  streamId: z.literal(AGENT_TEXT_STREAM_ID),
});
export type RealtimeAccess = z.infer<typeof RealtimeAccess>;
