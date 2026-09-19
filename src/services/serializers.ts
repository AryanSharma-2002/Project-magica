import { z } from "zod";
import {
  Attachment,
  AttachmentKind,
  AttachmentSource,
  AttachmentStatus,
  ContentBlocks,
  JsonValue,
  LedgerEntry,
  LedgerEntryType,
  Message,
  MessageRole,
  MessageStatus,
  RunStatus,
  RunUsage,
  SafeError,
  ToolInvocation,
  ToolInvocationStatus,
  Waitpoint,
  WaitpointPrompt,
  WaitpointResolution,
  WaitpointStatus,
  WaitpointType,
  type AgentRun,
  type Chat,
} from "@agent-chat/contracts";
import type {
  AgentRun as DbAgentRun,
  Attachment as DbAttachment,
  Chat as DbChat,
  CreditLedger as DbCreditLedger,
  Message as DbMessage,
  RunSkill as DbRunSkill,
  ToolInvocation as DbToolInvocation,
  Waitpoint as DbWaitpoint,
} from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { mc } from "@/lib/db";

/**
 * Prisma rows -> contract objects. DB UPPER enums map to contract lowercase by simple
 * `.toLowerCase()` (verified 1:1 against packages/contracts/src/enums.ts). Every JSONB column
 * is parsed through its contract schema; a parse failure is a server-side data bug (`internal`),
 * never a client validation error.
 */

function mapEnum<T>(schema: z.ZodType<T>, value: string, label: string): T {
  const parsed = schema.safeParse(value.toLowerCase());
  if (!parsed.success) throw new AppError("internal", `Corrupt persisted ${label}`, { cause: parsed.error });
  return parsed.data;
}

function parseJsonb<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("internal", `Corrupt persisted ${label}`, { cause: parsed.error });
  return parsed.data;
}

function parseNullableJsonb<T>(schema: z.ZodType<T>, value: unknown, label: string): T | null {
  if (value === null || value === undefined) return null;
  return parseJsonb(schema, value, label);
}

/** Shared helper so callers outside this module (run-store, runs service) validate the same way. */
export function parseContentBlocks(value: unknown): z.infer<typeof ContentBlocks> {
  return parseJsonb(ContentBlocks, value, "Message.content");
}

export function serializeAttachment(row: DbAttachment): Attachment {
  return {
    id: row.id,
    kind: mapEnum(AttachmentKind, row.kind, "Attachment.kind"),
    source: mapEnum(AttachmentSource, row.source, "Attachment.source"),
    status: mapEnum(AttachmentStatus, row.status, "Attachment.status"),
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: row.url,
    previewUrl: row.previewUrl,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    position: row.position,
    assemblyId: row.assemblyId,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeMessage(row: DbMessage, attachments: DbAttachment[]): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    role: mapEnum(MessageRole, row.role, "Message.role"),
    status: mapEnum(MessageStatus, row.status, "Message.status"),
    content: parseJsonb(ContentBlocks, row.content, "Message.content"),
    runId: row.runId,
    attachments: attachments.map(serializeAttachment),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeChat(row: DbChat, activeRunId: string | null): Chat {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    activeRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeToolInvocation(row: DbToolInvocation): ToolInvocation {
  return {
    id: row.id,
    runId: row.runId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    status: mapEnum(ToolInvocationStatus, row.status, "ToolInvocation.status"),
    input: parseJsonb(JsonValue, row.input, "ToolInvocation.input"),
    output: parseNullableJsonb(JsonValue, row.output, "ToolInvocation.output"),
    error: parseNullableJsonb(SafeError, row.error, "ToolInvocation.error"),
    providerRunId: row.providerRunId,
    microcreditsEstimated: mc(row.microcreditsEstimated),
    microcreditsCharged: mc(row.microcreditsCharged),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeWaitpoint(row: DbWaitpoint): Waitpoint {
  return {
    id: row.id,
    runId: row.runId,
    toolInvocationId: row.toolInvocationId,
    type: mapEnum(WaitpointType, row.type, "Waitpoint.type"),
    status: mapEnum(WaitpointStatus, row.status, "Waitpoint.status"),
    prompt: parseJsonb(WaitpointPrompt, row.prompt, "Waitpoint.prompt"),
    resolution: parseNullableJsonb(WaitpointResolution, row.resolution, "Waitpoint.resolution"),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeAgentRun(
  row: DbAgentRun,
  relations: { toolInvocations: DbToolInvocation[]; waitpoint: DbWaitpoint | null; loadedSkills: DbRunSkill[] },
): AgentRun {
  return {
    id: row.id,
    chatId: row.chatId,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    status: mapEnum(RunStatus, row.status, "AgentRun.status"),
    requestedModel: row.requestedModel,
    routedModel: row.routedModel,
    planMode: row.planMode,
    currentStep: row.currentStep,
    usage: parseNullableJsonb(RunUsage, row.usage, "AgentRun.usage"),
    microcreditsReserved: mc(row.microcreditsReserved),
    microcreditsCharged: mc(row.microcreditsCharged),
    error: parseNullableJsonb(SafeError, row.error, "AgentRun.error"),
    toolInvocations: relations.toolInvocations.map(serializeToolInvocation),
    waitpoint: relations.waitpoint ? serializeWaitpoint(relations.waitpoint) : null,
    loadedSkills: relations.loadedSkills.map((s) => ({ name: s.skillName, contentHash: s.contentHash, assetPath: s.assetPath })),
    triggerRunId: row.triggerRunId,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeLedgerEntry(row: DbCreditLedger): LedgerEntry {
  return {
    id: row.id,
    type: mapEnum(LedgerEntryType, row.type, "CreditLedger.type"),
    amount: mc(row.amount),
    balanceAfter: mc(row.balanceAfter),
    runId: row.runId,
    toolInvocationId: row.toolInvocationId,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}
