import { tasks, auth } from "@trigger.dev/sdk";
import type { agentTurnTask } from "@/trigger/agent-turn.task";
import {
  AGENT_TEXT_STREAM_ID,
  type RealtimeAccess,
  type RunUsage,
  type SendMessageRequest,
  type SendMessageResponse,
} from "@agent-chat/contracts";
import { prisma, Prisma } from "@/lib/db";
import { AppError, errors } from "@/lib/errors";
import { assertSendRateLimit } from "@/lib/rate-limit";
import { reserveAdmission } from "@/lib/credits";
import { getLimits } from "@/services/config";
import { createRunStore } from "@/services/run-store";
import { parseContentBlocks } from "@/services/serializers";
import type { Attachment as DbAttachment, AgentRun as DbAgentRun, RunStatus as RunStatusDb } from "@/generated/prisma/client";

/**
 * §5.1 send. Order follows the assignment spec exactly: ownership+attachments -> rate limit ->
 * idempotency lookup -> stale-lock recovery -> one transaction (admission reserve + messages +
 * run + attachment links + chat bump) -> dispatch -> realtime token. Note this differs slightly
 * from ARCHITECTURE.md's "rate limit -> idempotency -> ownership" ordering; see final report.
 */

const STALE_LOCK_MS = 5 * 60 * 1000;
const ACTIVE_RUN_DB: RunStatusDb[] = ["QUEUED", "RUNNING", "WAITING", "STOPPING"];
const ZERO_USAGE: RunUsage = { model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };

/** Prisma 7 + @prisma/adapter-pg puts constraint info in the formatted message, not `meta.target`. */
function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  return typeof err.message === "string" && err.message.includes(constraintName);
}

/** Sentinel thrown from inside the send transaction when a concurrent identical retry won the idempotency race. */
class IdempotencyRaceError extends Error {}

async function mintRealtimeAccess(triggerRunId: string): Promise<RealtimeAccess> {
  const publicAccessToken = await auth.createPublicToken({ scopes: { read: { runs: [triggerRunId] } }, expirationTime: "1h" });
  return {
    triggerRunId,
    publicAccessToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    streamId: AGENT_TEXT_STREAM_ID,
  };
}

async function buildDedupResponse(run: DbAgentRun): Promise<SendMessageResponse> {
  if (!run.triggerRunId) {
    // Extremely narrow window: a concurrent identical retry landed between this run's commit and
    // its dispatch update. Ask the caller to retry rather than fabricate a token for no trigger run.
    throw new AppError("conflict", "This message is still being dispatched. Please retry shortly.", { retryable: true });
  }
  return {
    chatId: run.chatId,
    messageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    runId: run.id,
    realtime: await mintRealtimeAccess(run.triggerRunId),
    deduplicated: true,
  };
}

async function loadAndValidateAttachments(userId: string, ids: readonly string[]): Promise<DbAttachment[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.attachment.findMany({ where: { id: { in: [...ids] } } });
  const byId = new Map(rows.map((a) => [a.id, a]));
  const ordered: DbAttachment[] = [];
  for (const id of ids) {
    const attachment = byId.get(id);
    if (!attachment || attachment.userId !== userId) throw errors.notFound("Attachment");
    if (attachment.status !== "READY") throw errors.validation(`Attachment ${id} is not ready`);
    ordered.push(attachment);
  }
  return ordered;
}

/** Finalizes a stalled active run as FAILED(stale_run_recovered) and releases its admission. No-op if none is stale. */
async function recoverStaleActiveRunOrThrow(chatId: string): Promise<void> {
  const activeRun = await prisma.agentRun.findFirst({ where: { chatId, status: { in: ACTIVE_RUN_DB } } });
  if (!activeRun) return;

  const now = Date.now();
  const heartbeatStale = activeRun.heartbeatAt !== null && now - activeRun.heartbeatAt.getTime() > STALE_LOCK_MS;
  const neverStartedStale = activeRun.startedAt === null && now - activeRun.createdAt.getTime() > STALE_LOCK_MS;
  if (!heartbeatStale && !neverStartedStale) throw errors.runActive();

  const assistantMessage = await prisma.message.findUniqueOrThrow({ where: { id: activeRun.assistantMessageId } });
  await createRunStore().finalize(activeRun.id, {
    status: "failed",
    blocks: parseContentBlocks(assistantMessage.content),
    usage: ZERO_USAGE,
    routedModel: null,
    error: { code: "stale_run_recovered", message: "This run stalled and was recovered automatically. Please try again.", retryable: true },
  });
}

export async function sendMessage(
  userId: string,
  chatId: string,
  req: SendMessageRequest,
  idempotencyKeyHeader: string | null,
): Promise<SendMessageResponse> {
  const limits = getLimits();

  // 1. Ownership + attachments.
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null } });
  if (!chat) throw errors.notFound("Chat");
  const attachments = await loadAndValidateAttachments(userId, req.attachmentIds);

  // 2. Rate limit.
  await assertSendRateLimit(userId);

  // 3. Idempotency.
  const idempotencyKey = idempotencyKeyHeader?.trim() ? idempotencyKeyHeader.trim() : crypto.randomUUID();
  const existingRun = await prisma.agentRun.findUnique({ where: { idempotencyKey } });
  if (existingRun) return buildDedupResponse(existingRun);

  // 4. Stale-lock recovery (throws run_active if the existing active run is not stale).
  await recoverStaleActiveRunOrThrow(chatId);

  // 5. One transaction: reserve admission, create messages + run, link attachments, bump chat.
  let created: { userMessageId: string; assistantMessageId: string; run: DbAgentRun };
  try {
    created = await prisma.$transaction(async (tx) => {
      const userMessage = await tx.message.create({
        data: { chatId, userId, role: "USER", status: "COMPLETED", content: [{ type: "text", text: req.text }], textContent: req.text },
      });
      const assistantMessage = await tx.message.create({
        data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] },
      });

      let run: DbAgentRun;
      try {
        run = await tx.agentRun.create({
          data: {
            chatId,
            userId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            idempotencyKey,
            requestedModel: req.model,
            planMode: req.planMode,
            status: "QUEUED",
            microcreditsReserved: BigInt(limits.admissionMicrocredits),
          },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, "AgentRun_one_active_per_chat")) throw errors.runActive();
        if (isUniqueViolationOn(err, "AgentRun_idempotencyKey_key")) throw new IdempotencyRaceError();
        throw err;
      }

      // Admission reservation is checked against balance; insufficient credits rolls back the whole tx.
      await reserveAdmission({ userId, runId: run.id, microcredits: limits.admissionMicrocredits }, tx);

      if (attachments.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: attachments.map((a) => a.id) } },
          data: { messageId: userMessage.id, chatId },
        });
      }

      const trimmedText = req.text.trim();
      const chatData: Prisma.ChatUpdateInput = { lastMessageAt: new Date() };
      if (chat.title === "New chat" && trimmedText.length > 0) chatData.title = trimmedText.slice(0, 60);
      await tx.chat.update({ where: { id: chatId }, data: chatData });

      return { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, run };
    });
  } catch (err) {
    if (err instanceof IdempotencyRaceError) {
      const raced = await prisma.agentRun.findUnique({ where: { idempotencyKey } });
      if (raced) return buildDedupResponse(raced);
    }
    throw err;
  }

  const { userMessageId, assistantMessageId, run } = created;

  // 6. Dispatch. A trigger failure finalizes the run (FAILED, admission released) and surfaces as an AppError.
  let triggerRunId: string;
  try {
    const handle = await tasks.trigger<typeof agentTurnTask>(
      "agent-turn",
      { runId: run.id },
      { idempotencyKey: run.idempotencyKey, tags: [`chat:${chatId}`, `user:${userId}`] },
    );
    triggerRunId = handle.id;
  } catch (err) {
    await createRunStore().finalize(run.id, {
      status: "failed",
      blocks: [],
      usage: ZERO_USAGE,
      routedModel: null,
      error: { code: "provider_unavailable", message: "Could not start the agent. Please try again.", retryable: true },
    });
    throw new AppError("provider_unavailable", "Could not start the agent. Please try again.", { retryable: true, cause: err });
  }
  await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } });

  // 7/8. Realtime access + response.
  return {
    chatId,
    messageId: userMessageId,
    assistantMessageId,
    runId: run.id,
    realtime: await mintRealtimeAccess(triggerRunId),
    deduplicated: false,
  };
}
