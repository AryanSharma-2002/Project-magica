import { z } from "zod";
import { Id, IsoDate, JsonValue, Microcredits, SignedMicrocredits } from "./primitives";
import {
  AttachmentKind,
  AttachmentSource,
  AttachmentStatus,
  LedgerEntryType,
  MessageRole,
  MessageStatus,
  RunStatus,
  ToolInvocationStatus,
} from "./enums";
import { ContentBlocks } from "./blocks";
import { SafeError } from "./errors";
import { Waitpoint } from "./waitpoints";

export const Attachment = z.object({
  id: Id,
  kind: AttachmentKind,
  source: AttachmentSource,
  status: AttachmentStatus,
  filename: z.string().max(255),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().nonnegative(),
  url: z.string().url().nullable(),
  previewUrl: z.string().url().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Stable order within a message (client-assigned at upload time, server-validated). */
  position: z.number().int().nonnegative(),
  assemblyId: z.string().max(128).nullable(),
  expiresAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  id: Id,
  chatId: Id,
  role: MessageRole,
  status: MessageStatus,
  content: ContentBlocks,
  runId: Id.nullable(),
  attachments: z.array(Attachment),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Message = z.infer<typeof Message>;

export const Chat = z.object({
  id: Id,
  title: z.string().max(200),
  pinned: z.boolean(),
  lastMessageAt: IsoDate.nullable(),
  /** Server-owned pointer used for reload recovery. */
  activeRunId: Id.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Chat = z.infer<typeof Chat>;

export const ToolInvocation = z.object({
  id: Id,
  runId: Id.nullable(),
  toolCallId: z.string().max(128),
  toolName: z.string().max(64),
  status: ToolInvocationStatus,
  input: JsonValue,
  output: JsonValue.nullable(),
  error: SafeError.nullable(),
  providerRunId: z.string().max(128).nullable(),
  microcreditsEstimated: Microcredits,
  microcreditsCharged: Microcredits,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: IsoDate,
});
export type ToolInvocation = z.infer<typeof ToolInvocation>;

export const RunUsage = z.object({
  model: z.string().max(200).nullable(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  llmCalls: z.number().int().nonnegative(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const AgentRun = z.object({
  id: Id,
  chatId: Id,
  userMessageId: Id,
  assistantMessageId: Id,
  status: RunStatus,
  requestedModel: z.string().max(200),
  routedModel: z.string().max(200).nullable(),
  planMode: z.boolean(),
  currentStep: z.string().max(200).nullable(),
  usage: RunUsage.nullable(),
  microcreditsReserved: Microcredits,
  microcreditsCharged: Microcredits,
  error: SafeError.nullable(),
  toolInvocations: z.array(ToolInvocation),
  waitpoint: Waitpoint.nullable(),
  loadedSkills: z.array(z.object({ name: z.string(), contentHash: z.string(), assetPath: z.string() })),
  triggerRunId: z.string().max(128).nullable(),
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type AgentRun = z.infer<typeof AgentRun>;

export const LedgerEntry = z.object({
  id: Id,
  type: LedgerEntryType,
  amount: SignedMicrocredits,
  balanceAfter: Microcredits,
  runId: Id.nullable(),
  toolInvocationId: Id.nullable(),
  description: z.string().max(300),
  createdAt: IsoDate,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const SkillDescriptor = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(500),
  version: z.string().max(32).optional(),
  assets: z.array(z.string().max(255)),
  contentHash: z.string().length(64),
});
export type SkillDescriptor = z.infer<typeof SkillDescriptor>;
