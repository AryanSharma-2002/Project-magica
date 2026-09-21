import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk";
import {
  API_PREFIX,
  type JsonValue,
  type PublicCompletionRequest,
  type PublicCompletionResponse,
  type PublicToolRunRequest,
  type PublicToolRunResponse,
  type ToolInvocation,
} from "@agent-chat/contracts";
import type { toolRunTask } from "@/trigger/tool-run.task";
import { prisma, Prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { AppError, errors } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { balance, releaseInvocation, reserveInvocation } from "@/lib/credits";
import { toolRegistry } from "@/agent/tools";
import { guessMimeType } from "@/agent/tools/definitions/shared";
import type { ToolContext } from "@/agent/tools/types";
import { createChat } from "@/services/chats";
import { sendMessage } from "@/services/send";
import { serializeToolInvocation } from "@/services/serializers";
import type { AttachmentKind as DbAttachmentKind } from "@/generated/prisma/client";

/**
 * Public API (ARCHITECTURE.md §9, `apiKey` auth): `POST /completions` (message -> agent run) and
 * `POST /tools/:name/run` + `GET /tools/runs/:invocationId` (standalone Magica tool invocation,
 * no AgentRun at all). Both are thin: real orchestration is `sendMessage` (send.ts) and the
 * `tool-run` task (src/trigger/tool-run.task.ts).
 */

function statusUrl(path: string): string {
  return `${getEnv().PUBLIC_API_BASE_URL}${API_PREFIX}${path}`;
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a"]);
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" };

function urlExtension(url: string): string {
  try {
    return new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

/** png/jpg/jpeg/webp/gif -> IMAGE, mp4/mov/webm -> VIDEO, mp3/wav/m4a -> AUDIO, else FILE. */
function inferAttachmentKind(url: string): DbAttachmentKind {
  const ext = urlExtension(url);
  if (IMAGE_EXTENSIONS.has(ext)) return "IMAGE";
  if (VIDEO_EXTENSIONS.has(ext)) return "VIDEO";
  if (AUDIO_EXTENSIONS.has(ext)) return "AUDIO";
  return "FILE";
}

/**
 * `guessMimeType` (src/agent/tools/definitions/shared.ts) only covers image/video extensions
 * (it's built for Magica tool inputs); audio/file are handled locally here.
 */
function inferMimeType(url: string, kind: DbAttachmentKind): string {
  if (kind === "IMAGE") return guessMimeType(url, "image");
  if (kind === "VIDEO") return guessMimeType(url, "video");
  if (kind === "AUDIO") return AUDIO_MIME_BY_EXTENSION[urlExtension(url)] ?? "audio/mpeg";
  return "application/octet-stream";
}

function filenameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base).slice(0, 255);
  } catch {
    /* fall through to the default name */
  }
  return "attachment";
}

/**
 * `sendMessage` namespaces `AgentRun.idempotencyKey` as `${userId}:${chatId}:${raw}` (§5.1). When
 * the caller omits `chatId`, there is no chat to look the key up under yet, so a repeat of the
 * SAME raw key must be found by scanning for `${userId}:*:${raw}` instead. `startsWith`/`endsWith`
 * alone can false-match a different run whose raw key happens to contain a colon (e.g. raw "a:b"
 * makes a key that also ends with ":b"), so candidates are re-verified against the run's own
 * chatId before being treated as a match.
 */
async function findExistingCompletionRun(userId: string, raw: string) {
  const candidates = await prisma.agentRun.findMany({
    where: { idempotencyKey: { startsWith: `${userId}:`, endsWith: `:${raw}` } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return candidates.find((run) => run.idempotencyKey === `${userId}:${run.chatId}:${raw}`) ?? null;
}

export async function createCompletion(
  principalUserId: string,
  body: PublicCompletionRequest,
  idempotencyKeyHeader: string | null,
): Promise<PublicCompletionResponse> {
  const raw = idempotencyKeyHeader?.trim();

  let chatId: string;
  /** Set when THIS call created the chat, so a rejected send can remove it again (no orphan "New chat"). */
  let createdChatId: string | null = null;
  if (body.chatId) {
    const chat = await prisma.chat.findFirst({ where: { id: body.chatId, userId: principalUserId, deletedAt: null } });
    if (!chat) throw errors.notFound("Chat");
    chatId = chat.id;

    // Exact-key dedupe BEFORE creating anything: with an explicit chatId the full idempotencyKey
    // (`${userId}:${chatId}:${raw}`) is known up front, so this is a precise lookup, not the
    // substring scan the no-chatId branch below needs. Returning early here (like the no-chatId
    // branch does) avoids leaving orphan READY/LIBRARY Attachment rows behind on every retry.
    if (raw) {
      const existing = await prisma.agentRun.findUnique({ where: { idempotencyKey: `${principalUserId}:${chatId}:${raw}` } });
      if (existing) {
        return {
          chatId: existing.chatId,
          runId: existing.id,
          messageId: existing.userMessageId,
          assistantMessageId: existing.assistantMessageId,
          statusUrl: statusUrl(`/runs/${existing.id}`),
        };
      }
    }
  } else {
    if (raw) {
      const existing = await findExistingCompletionRun(principalUserId, raw);
      if (existing) {
        return {
          chatId: existing.chatId,
          runId: existing.id,
          messageId: existing.userMessageId,
          assistantMessageId: existing.assistantMessageId,
          statusUrl: statusUrl(`/runs/${existing.id}`),
        };
      }
    }
    const chat = await createChat(principalUserId, { title: body.message.slice(0, 60) });
    chatId = chat.id;
    createdChatId = chat.id;
  }

  const attachmentIds: string[] = [];
  for (let i = 0; i < body.attachmentUrls.length; i++) {
    const url = body.attachmentUrls[i]!;
    const kind = inferAttachmentKind(url);
    const attachment = await prisma.attachment.create({
      data: {
        userId: principalUserId,
        kind,
        source: "LIBRARY",
        status: "READY",
        filename: filenameFromUrl(url),
        mimeType: inferMimeType(url, kind),
        sizeBytes: 0,
        url,
        previewUrl: url,
        position: i,
      },
    });
    attachmentIds.push(attachment.id);
  }

  let sent;
  try {
    sent = await sendMessage(
      principalUserId,
      chatId,
      { text: body.message, attachmentIds, model: "openrouter/free", planMode: body.planMode },
      idempotencyKeyHeader,
    );
  } catch (err) {
    // sendMessage validates (rate limit, admission credits, active run) BEFORE it writes anything,
    // so on rejection the chat and library attachments created above are the only leftovers.
    // Both deletes are best-effort: the FK on a message would make chat.delete a no-op failure.
    if (attachmentIds.length > 0) await prisma.attachment.deleteMany({ where: { id: { in: attachmentIds }, messageId: null } }).catch(() => undefined);
    if (createdChatId) await prisma.chat.delete({ where: { id: createdChatId } }).catch(() => undefined);
    throw err;
  }

  return {
    chatId: sent.chatId,
    runId: sent.runId,
    messageId: sent.messageId,
    assistantMessageId: sent.assistantMessageId,
    statusUrl: statusUrl(`/runs/${sent.runId}`),
  };
}

// ---------------------------------------------------------------------------
// Standalone tool runs
// ---------------------------------------------------------------------------

export async function startToolRun(userId: string, toolName: string, body: PublicToolRunRequest): Promise<PublicToolRunResponse> {
  // Only the durable Magica tools are exposed standalone: a programmatic caller has no LLM turn
  // and no way to satisfy an approval waitpoint, so anything else (skills tools, a future inline
  // tool) is simply not a valid target here. Checked BEFORE parseInput: `toolRegistry.get()` on an
  // unknown name throws `malformed_tool_call`, but an unknown/ineligible tool name on this route
  // is `not_found`, not a validation error.
  if (!toolRegistry.has(toolName)) throw errors.notFound("Tool");
  const tool = toolRegistry.get(toolName);
  if (tool.execution !== "durable_child_task") throw errors.notFound("Tool");

  // `parseInput` throws `malformed_tool_call`, which the repo-wide HTTP mapping treats as a
  // provider-side failure (502) because inside a run it means the MODEL produced bad arguments.
  // On this route the arguments came from the HTTP caller, so it is a plain 400 validation error.
  let parsed: unknown;
  try {
    parsed = await toolRegistry.parseInput(tool.name, body.input);
  } catch (err) {
    const app = AppError.from(err);
    if (app.code !== "malformed_tool_call") throw app;
    throw errors.validation(`Invalid input for tool ${tool.name}`, { toolName: tool.name, issues: (app.details as { issues?: unknown } | undefined)?.issues ?? [] });
  }

  // The public API does NOT run an approval waitpoint (ARCHITECTURE.md §5.3/§7 approval policy is
  // an agent-loop concept: it exists because the MODEL chose to call a paid tool on the user's
  // behalf mid-conversation). A programmatic caller hitting this endpoint has already explicitly
  // and deliberately requested exactly this tool with exactly this input, so that consent step is
  // redundant here - it still enforces the balance check (below), just never asks a human to click
  // "approve".
  const toolCallId = `pub_${randomUUID()}`;
  const estimateCtx: ToolContext = {
    userId,
    runId: null,
    chatId: null,
    // Placeholder: the real invocationId does not exist until the row below is created, which
    // itself needs the estimate first - mirrors src/agent/loop/tools.ts's use of the LLM call id
    // as a placeholder ToolContext.invocationId at estimate time.
    invocationId: toolCallId,
    toolCallId,
    signal: new AbortController().signal,
    log: logger({ userId }),
    attachments: [],
  };
  const estimate = Math.trunc(await tool.estimate(parsed as never, estimateCtx));
  const sanitizedInput = (tool.sanitizeInput?.(parsed as never) ?? (parsed as JsonValue)) as JsonValue;

  // Pre-check for a clean error message; the authoritative check is the reservation itself,
  // which runs in the SAME transaction as the invocation row so "insufficient credits" leaves
  // no invocation behind at all (the ledger's toolInvocationId FK requires the row to exist
  // before `reserve:<id>` is written, so the row must be created first - but atomically with it).
  const available = await balance(userId);
  if (available < estimate) throw errors.insufficientCredits(estimate, available);

  const invocation = await prisma.$transaction(async (tx) => {
    const created = await tx.toolInvocation.create({
      data: {
        userId,
        runId: null,
        messageId: null,
        toolCallId,
        toolName: tool.name,
        status: "PENDING",
        input: sanitizedInput as Prisma.InputJsonValue,
        microcreditsEstimated: BigInt(estimate),
      },
    });
    await reserveInvocation({ userId, runId: null, invocationId: created.id, microcredits: estimate }, tx);
    return created;
  });

  try {
    await tasks.trigger<typeof toolRunTask>("tool-run", { invocationId: invocation.id, input: parsed as JsonValue }, { idempotencyKey: invocation.id });
  } catch (err) {
    await releaseInvocation({ userId, runId: null, invocationId: invocation.id, estimated: estimate }).catch(() => {});
    await prisma.toolInvocation
      .update({
        where: { id: invocation.id },
        data: {
          status: "FAILED",
          error: { code: "provider_unavailable", message: "Could not start the tool run. Please try again.", retryable: true } as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    throw new AppError("provider_unavailable", "Could not start the tool run. Please try again.", { retryable: true, cause: err });
  }

  return { invocationId: invocation.id, status: "pending", statusUrl: statusUrl(`/tools/runs/${invocation.id}`) };
}

export async function getToolRun(userId: string, invocationId: string): Promise<ToolInvocation> {
  const row = await prisma.toolInvocation.findFirst({ where: { id: invocationId, userId } });
  if (!row) throw errors.notFound("Tool invocation");
  return serializeToolInvocation(row);
}
