import { task } from "@trigger.dev/sdk";
import type { JsonValue } from "@agent-chat/contracts";
import { prisma, mc, Prisma } from "@/lib/db";
import { logger, type Logger } from "@/lib/logger";
import { releaseInvocation, settleInvocation } from "@/lib/credits";
import { providerChargeFromError } from "@/agent/tools/types";
import { magicaToolTask, type MagicaToolResult } from "@/trigger/magica-tool.task";
import { ToolInvocationStatus } from "@/generated/prisma/enums";
import type { ToolInvocation as DbToolInvocation } from "@/generated/prisma/client";

/**
 * Durable orchestrator for a STANDALONE public-API tool run (ARCHITECTURE.md §9,
 * `POST /tools/:name/run`). No AgentRun/agent loop is involved: this task's only jobs are (1)
 * dispatch the same `magica-tool` child task the agent loop uses (idempotencyKey = invocationId,
 * so a duplicate `tool-run` dispatch — e.g. a retried trigger — rejoins the same child run instead
 * of re-billing the provider) and (2) settle/release the credit reservation the route already
 * made. The child persists ToolInvocation's terminal status (COMPLETED/FAILED/CANCELLED) and any
 * settled charge itself (see src/trigger/magica-tool.task.ts) — this task never touches that row's
 * status except in the one path where nothing else could have (see below).
 *
 * The two-layer `triggerAndWait` result is unwrapped the same way as
 * src/trigger/adapters/durable.ts, copied rather than imported: that adapter implements
 * `DurableExecutor`, whose contract (return output / throw AppError) has no room for this task's
 * own job of settling a standalone reservation — mirror the unwrap logic, not the interface.
 */

export type ToolRunPayload = { invocationId: string; input: JsonValue };

const TERMINAL_STATUSES: ReadonlySet<ToolInvocationStatus> = new Set([
  ToolInvocationStatus.COMPLETED,
  ToolInvocationStatus.FAILED,
  ToolInvocationStatus.CANCELLED,
]);

/**
 * Idempotent settle/release from a row that is ALREADY terminal — used both for a replay of a
 * finished invocation (nothing left to do but make sure credits were settled: the ledger's
 * `idempotencyKey` on `release:<id>`/`charge:<id>` makes a repeat call a no-op, never a double
 * charge) and for the one path below where this task marks the row terminal itself.
 */
async function settleFromStoredRow(row: Pick<DbToolInvocation, "id" | "userId" | "status" | "microcreditsEstimated" | "microcreditsCharged">, log: Logger): Promise<void> {
  const estimated = mc(row.microcreditsEstimated);
  const charged = mc(row.microcreditsCharged);
  try {
    if (row.status === ToolInvocationStatus.COMPLETED || charged > 0) {
      await settleInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated, charged });
    } else {
      await releaseInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated });
    }
  } catch (err) {
    log.error({ err, invocationId: row.id }, "tool-run: failed to settle/release credits");
  }
}

/** Nothing downstream persisted a terminal state (the child itself crashed) — this task must. */
async function failWithoutCharge(row: Pick<DbToolInvocation, "id" | "userId" | "microcreditsEstimated">, log: Logger): Promise<void> {
  await releaseInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated: mc(row.microcreditsEstimated) }).catch((err: unknown) =>
    log.error({ err, invocationId: row.id }, "tool-run: release failed"),
  );
  await prisma.toolInvocation
    .update({
      where: { id: row.id },
      data: {
        status: ToolInvocationStatus.FAILED,
        error: { code: "provider_unavailable", message: "The tool run could not be completed. Please try again.", retryable: true } as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    })
    .catch((err: unknown) => log.error({ err, invocationId: row.id }, "tool-run: failed to persist failure state"));
}

export const toolRunTask = task({
  id: "tool-run",
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (payload: ToolRunPayload, params): Promise<void> => {
    const log = logger({ toolInvocationId: payload.invocationId, triggerRunId: params.ctx.run.id });

    const row = await prisma.toolInvocation.findUnique({ where: { id: payload.invocationId } });
    if (!row) {
      log.error({ invocationId: payload.invocationId }, "tool-run: invocation not found");
      return;
    }

    // Idempotent replay: a previous attempt already ran the child and (should have) settled
    // credits. Never re-dispatch the child for an already-terminal invocation; just make sure the
    // ledger agrees with the stored row (a no-op if it already does).
    if (TERMINAL_STATUSES.has(row.status)) {
      await settleFromStoredRow(row, log);
      return;
    }

    let dispatched: Awaited<ReturnType<typeof magicaToolTask.triggerAndWait>>;
    try {
      dispatched = await magicaToolTask.triggerAndWait(
        { invocationId: payload.invocationId, input: payload.input },
        { idempotencyKey: payload.invocationId, idempotencyKeyTTL: "24h" },
      );
    } catch (err) {
      log.error({ err }, "tool-run: triggerAndWait threw");
      await failWithoutCharge(row, log);
      return;
    }

    if (!dispatched.ok) {
      // Layer 1: the child task itself crashed instead of returning its own MagicaToolResult
      // ("normally never does" per src/trigger/adapters/durable.ts). Nothing was billed, and
      // nobody persisted a terminal status for this row — this task must.
      log.error({ err: dispatched.error }, "tool-run: magica-tool child task crashed");
      await failWithoutCharge(row, log);
      return;
    }

    // Layer 2: the child's own result. It already persisted COMPLETED/FAILED/CANCELLED (and any
    // settled charge on the row) itself — this task only settles the ledger to match.
    const child: MagicaToolResult = dispatched.output;
    const estimated = mc(row.microcreditsEstimated);
    try {
      if (child.ok) {
        await settleInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated, charged: child.microcreditsCharged });
      } else {
        const settled = providerChargeFromError(child.error);
        if (settled.microcreditsCharged > 0) {
          await settleInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated, charged: settled.microcreditsCharged });
        } else {
          await releaseInvocation({ userId: row.userId, runId: null, invocationId: row.id, estimated });
        }
      }
    } catch (err) {
      log.error({ err }, "tool-run: failed to settle/release credits");
    }
  },
});
