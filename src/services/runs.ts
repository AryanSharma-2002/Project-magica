import { auth, wait } from "@trigger.dev/sdk";
import {
  AGENT_TEXT_STREAM_ID,
  type AgentRun,
  type RealtimeAccess,
  type RunUsage,
  type WaitpointResolution,
  type Waitpoint,
} from "@agent-chat/contracts";
import { prisma, Prisma } from "@/lib/db";
import { errors } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { serializeAgentRun, serializeWaitpoint, parseContentBlocks } from "@/services/serializers";
import { createRunStore } from "@/services/run-store";

const ZERO_USAGE: RunUsage = { model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };

async function loadRunRelations(runId: string) {
  const [toolInvocations, waitpointRow, skills] = await Promise.all([
    prisma.toolInvocation.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
    prisma.waitpoint.findFirst({ where: { runId, status: "PENDING" }, orderBy: { createdAt: "desc" } }),
    prisma.runSkill.findMany({ where: { runId } }),
  ]);
  return { toolInvocations, waitpoint: waitpointRow, loadedSkills: skills };
}

export async function getRun(userId: string, runId: string): Promise<AgentRun> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw errors.notFound("AgentRun");
  const relations = await loadRunRelations(runId);
  return serializeAgentRun(run, relations);
}

/**
 * §5.5 cancellation. STOPPING is a request, not an outcome: a QUEUED run that never started is
 * finalized CANCELLED immediately (nothing will ever pick it up otherwise); a WAITING run has its
 * pending waitpoint cancelled and the Trigger token completed with `{ cancelled: true }`; a RUNNING
 * run is left at STOPPING for the task loop to observe and finalize on its own.
 */
export async function cancelRun(userId: string, runId: string): Promise<AgentRun> {
  const existing = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!existing) throw errors.notFound("AgentRun");

  // Atomically claim "queued and never started" against the DB, not an in-process snapshot: if
  // this update lands, no task will ever observe this run, so it's safe to finalize CANCELLED
  // immediately. This is raced against `markRunning` through the WHERE clause itself (whichever
  // write commits first wins) rather than against a `findFirst` read taken moments earlier.
  const claimedNeverStarted = await prisma.agentRun.updateMany({
    where: { id: runId, status: "QUEUED", startedAt: null },
    data: { status: "STOPPING", cancelRequestedAt: new Date() },
  });

  if (claimedNeverStarted.count === 1) {
    const assistantMessage = await prisma.message.findUniqueOrThrow({ where: { id: existing.assistantMessageId } });
    await createRunStore().finalize(runId, {
      status: "cancelled",
      blocks: parseContentBlocks(assistantMessage.content),
      usage: ZERO_USAGE,
      routedModel: null,
    });
  } else {
    const transitioned = await prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ["QUEUED", "RUNNING", "WAITING"] } },
      data: { status: "STOPPING", cancelRequestedAt: new Date() },
    });
    if (transitioned.count > 0) {
      const waitpointRow = await prisma.waitpoint.findFirst({ where: { runId, status: "PENDING" } });
      if (waitpointRow) {
        const cancelled = await prisma.waitpoint.updateMany({
          where: { id: waitpointRow.id, status: "PENDING" },
          data: { status: "CANCELLED", resolvedAt: new Date() },
        });
        if (cancelled.count === 1) {
          try {
            await wait.completeToken(waitpointRow.triggerTokenId, { cancelled: true });
          } catch (err) {
            logger({ runId, waitpointTokenId: waitpointRow.triggerTokenId }).error({ err }, "completeToken failed after cancel transition");
          }
        }
      }
    }
  }

  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const relations = await loadRunRelations(runId);
  return serializeAgentRun(run, relations);
}

export async function realtimeToken(userId: string, runId: string): Promise<RealtimeAccess> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run || !run.triggerRunId) throw errors.notFound("AgentRun");
  const expirationTime = "1h";
  const publicAccessToken = await auth.createPublicToken({ scopes: { read: { runs: [run.triggerRunId] } }, expirationTime });
  return {
    triggerRunId: run.triggerRunId,
    publicAccessToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    streamId: AGENT_TEXT_STREAM_ID,
  };
}

/**
 * §5.4 waitpoint completion. The DB transition is the source of truth: `completeToken` failure
 * after a successful `PENDING -> COMPLETED` transition is logged and retried once, never surfaced
 * to the caller as an error (the resolution already stands).
 */
export async function completeWaitpoint(userId: string, waitpointId: string, resolution: WaitpointResolution): Promise<Waitpoint> {
  const waitpointRow = await prisma.waitpoint.findUnique({
    where: { id: waitpointId },
    include: { run: { select: { userId: true } } },
  });
  if (!waitpointRow || waitpointRow.run.userId !== userId) throw errors.notFound("Waitpoint");

  if (waitpointRow.type.toLowerCase() !== resolution.type) {
    throw errors.validation("Resolution type does not match the waitpoint's type");
  }

  const transitioned = await prisma.waitpoint.updateMany({
    where: { id: waitpointId, status: "PENDING" },
    data: { status: "COMPLETED", resolution: resolution as unknown as Prisma.InputJsonValue, resolvedAt: new Date() },
  });

  if (transitioned.count === 1) {
    const complete = () => wait.completeToken(waitpointRow.triggerTokenId, { resolution });
    try {
      await complete();
    } catch (err) {
      logger({ waitpointTokenId: waitpointRow.triggerTokenId }).error({ err }, "completeToken failed; retrying once");
      try {
        await complete();
      } catch (err2) {
        logger({ waitpointTokenId: waitpointRow.triggerTokenId }).error({ err: err2 }, "completeToken retry failed; DB transition stands");
      }
    }
  }

  const finalRow = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpointId } });
  return serializeWaitpoint(finalRow);
}
