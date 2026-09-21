import { metadata, task } from "@trigger.dev/sdk";
import type { JsonValue, SafeError, ToolName } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma, Prisma } from "@/lib/db";
import { toolRegistry } from "@/agent/tools";
import { providerChargeFromError, type ToolContext } from "@/agent/tools/types";
import { ToolInvocationStatus } from "@/generated/prisma/enums";
import { emitWebhookEvent } from "@/services/webhooks";

/**
 * Durable child task for a single Magica tool invocation (ARCHITECTURE.md §5.3). Triggered via
 * `magicaToolTask.triggerAndWait({ invocationId }, { idempotencyKey: invocationId })` from
 * src/trigger/adapters/durable.ts. Never throws: every path returns a MagicaToolResult so the
 * parent can distinguish "the child ran and failed" from "the child itself crashed".
 */

/** `input` is the parent loop's validated tool input (preferred). Older/replayed dispatches without it
 * fall back to the persisted `ToolInvocation.input`, which is display-sanitized and may be lossy. */
export type MagicaToolPayload = { invocationId: string; input?: JsonValue };

export type MagicaToolSuccess = {
  ok: true;
  output: JsonValue;
  providerRunId: string | null;
  microcreditsCharged: number;
  durationMs: number;
};
export type MagicaToolFailure = { ok: false; error: SafeError };
export type MagicaToolResult = MagicaToolSuccess | MagicaToolFailure;

/**
 * §5.3 / §9 emission point: `tool.completed` fires for every COMPLETED Magica invocation,
 * standalone or in a run. `chatId` is a cheap lookup off the invocation's `runId` when present
 * (null for standalone public-API tool runs, which have no run/chat at all) - null is acceptable
 * either way per the task brief. Best-effort: wrapped so a webhook problem can never fail the
 * (already-successful) tool invocation.
 */
async function emitToolCompleted(invocation: { id: string; userId: string; runId: string | null; toolName: string }): Promise<void> {
  try {
    const chatId = invocation.runId ? ((await prisma.agentRun.findUnique({ where: { id: invocation.runId }, select: { chatId: true } }))?.chatId ?? null) : null;
    await emitWebhookEvent({
      userId: invocation.userId,
      type: "tool.completed",
      data: { runId: invocation.runId, chatId, status: "completed", toolInvocationId: invocation.id, toolName: invocation.toolName },
    });
  } catch (err) {
    logger({ toolInvocationId: invocation.id }).error({ err }, "magica-tool: failed to emit tool.completed webhook event");
  }
}

const TERMINAL_STATUSES: ReadonlySet<ToolInvocationStatus> = new Set([
  ToolInvocationStatus.COMPLETED,
  ToolInvocationStatus.FAILED,
  ToolInvocationStatus.CANCELLED,
]);

export const magicaToolTask = task({
  id: "magica-tool",
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (payload: MagicaToolPayload, params): Promise<MagicaToolResult> => {
    const log = logger({ toolInvocationId: payload.invocationId, triggerRunId: params.ctx.run.id });

    const invocation = await prisma.toolInvocation.findUnique({ where: { id: payload.invocationId } });
    if (!invocation) {
      return { ok: false, error: { code: "not_found", message: "Tool invocation not found", retryable: false } };
    }

    // Idempotent replay: a terminal invocation already has its settled result persisted - never
    // re-issue HTTP against the provider for a replayed/duplicate dispatch.
    if (TERMINAL_STATUSES.has(invocation.status)) {
      if (invocation.status === ToolInvocationStatus.COMPLETED) {
        return {
          ok: true,
          output: (invocation.output ?? null) as JsonValue,
          providerRunId: invocation.providerRunId,
          microcreditsCharged: Number(invocation.microcreditsCharged),
          durationMs: invocation.durationMs ?? 0,
        };
      }
      const storedError = invocation.error as SafeError | null;
      return { ok: false, error: storedError ?? { code: "internal", message: "Tool invocation did not complete", retryable: false } };
    }

    try {
      const toolName = invocation.toolName as ToolName;
      const tool = toolRegistry.get(toolName);
      const input = await toolRegistry.parseInput(toolName, payload.input ?? invocation.input);

      await prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: { status: ToolInvocationStatus.RUNNING, startedAt: invocation.startedAt ?? new Date() },
      });

      const ctx: ToolContext = {
        userId: invocation.userId,
        runId: invocation.runId,
        chatId: null,
        invocationId: invocation.id,
        toolCallId: invocation.toolCallId,
        signal: params.signal,
        log,
        onProgress: (progress, label) => {
          // A distinct metadata key from the parent's own "run" key - the child must never
          // clobber the parent's in-memory RunMetadata snapshot (see adapters/realtime.ts).
          metadata.parent.set(`tool:${invocation.id}`, { progress, label: label ?? null });
        },
        attachments: [],
        existingProviderRunId: invocation.providerRunId,
        onProviderRunId: async (providerRunId) => {
          await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { providerRunId } });
        },
      };

      const result = await tool.execute(input, ctx);
      const output = toolRegistry.parseOutput(toolName, result.output) as JsonValue;
      const providerRunId = result.providerRunId ?? invocation.providerRunId;

      await prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: {
          status: ToolInvocationStatus.COMPLETED,
          output: output as Prisma.InputJsonValue,
          providerRunId,
          microcreditsCharged: BigInt(Math.trunc(result.microcreditsCharged)),
          durationMs: result.durationMs,
          finishedAt: new Date(),
        },
      });

      await emitToolCompleted({ id: invocation.id, userId: invocation.userId, runId: invocation.runId, toolName });

      return { ok: true, output, providerRunId: providerRunId ?? null, microcreditsCharged: result.microcreditsCharged, durationMs: result.durationMs };
    } catch (err) {
      const app = AppError.from(err);
      const safeError = app.toSafe();
      const status = app.code === "cancelled" ? ToolInvocationStatus.CANCELLED : ToolInvocationStatus.FAILED;
      // A failure AFTER the provider completed and billed (unparseable output) still carries the
      // settled charge; persist it so the row matches Magica's ledger and the parent can settle.
      const settled = providerChargeFromError(safeError);
      await prisma.toolInvocation
        .update({
          where: { id: invocation.id },
          data: {
            status,
            error: safeError as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(),
            ...(settled.microcreditsCharged > 0 ? { microcreditsCharged: BigInt(settled.microcreditsCharged) } : {}),
            ...(settled.providerRunId ? { providerRunId: settled.providerRunId } : {}),
          },
        })
        .catch((persistErr: unknown) => log.error({ err: persistErr }, "magica-tool: failed to persist failure state"));
      return { ok: false, error: safeError };
    }
  },
});
