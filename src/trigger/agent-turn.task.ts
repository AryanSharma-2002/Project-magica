import { task } from "@trigger.dev/sdk";
import type { RunUsage, SafeError, WebhookEventType } from "@agent-chat/contracts";
import type { RunOutcome, RunSnapshot } from "@/agent/loop/ports";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createRunStore } from "@/services/run-store";
import { emitWebhookEvent } from "@/services/webhooks";
import { runAgentTurn } from "@/agent/loop";
import { buildRunDeps } from "./adapters/deps";

export type AgentTurnPayload = { runId: string };

const EMPTY_USAGE: RunUsage = { model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * §5.2 point 1 / §9 emission points: `agent.started` fires right after the run snapshot is
 * loaded (before the loop's own QUEUED->RUNNING transition, which happens inside `runAgentTurn`
 * itself - a read-only module for this slice). Best-effort: `emitWebhookEvent` never throws, but
 * this is wrapped anyway so a bug in argument construction can't fail the run either.
 */
async function emitAgentStarted(snapshot: RunSnapshot): Promise<void> {
  try {
    await emitWebhookEvent({
      userId: snapshot.run.userId,
      type: "agent.started",
      data: { runId: snapshot.run.id, chatId: snapshot.run.chatId, status: "running" },
    });
  } catch (err) {
    logger({ runId: snapshot.run.id }).error({ err }, "agent-turn: failed to emit agent.started webhook event");
  }
}

/**
 * §5.2 point 4 / §9: a `cancelled` outcome is reported as `agent.completed` with
 * `data.status: "cancelled"` (per the ARCHITECTURE.md webhooks paragraph); `failed` is
 * `agent.failed`. Only covers the loop's own normal return - see the final report for why
 * `finalizeBestEffort` (onFailure/onCancel) does not also emit.
 */
async function emitAgentTerminal(snapshot: RunSnapshot, outcome: RunOutcome): Promise<void> {
  try {
    const type: WebhookEventType = outcome.status === "failed" ? "agent.failed" : "agent.completed";
    await emitWebhookEvent({
      userId: snapshot.run.userId,
      type,
      data: { runId: snapshot.run.id, chatId: snapshot.run.chatId, status: outcome.status },
    });
  } catch (err) {
    logger({ runId: snapshot.run.id }).error({ err }, "agent-turn: failed to emit terminal webhook event");
  }
}

/**
 * Best-effort finalize so a crashed/hard-cancelled worker never leaves a run stuck ACTIVE
 * (ARCHITECTURE.md §5.2 point 5). `store.finalize` is idempotent (`WHERE status IN (active)`), so
 * calling it here after the loop already finalized on its own path is a safe no-op.
 */
async function finalizeBestEffort(runId: string, status: "failed" | "cancelled", cause?: unknown): Promise<void> {
  const log = logger({ runId });
  try {
    const store = createRunStore();
    const snapshot = await store.loadSnapshot(runId).catch(() => undefined);
    const blocks = snapshot?.persistedBlocks ?? [];
    const error: SafeError =
      status === "cancelled"
        ? { code: "cancelled", message: "The run was cancelled.", retryable: false }
        : AppError.from(cause, { code: "internal" }).toSafe();
    await store.finalize(runId, { status, blocks, usage: EMPTY_USAGE, routedModel: null, error });
  } catch (err) {
    log.error({ err, status }, "agent-turn: best-effort finalize failed");
  }
}

export const agentTurnTask = task({
  id: "agent-turn",
  maxDuration: 3600,
  retry: { maxAttempts: 1 },

  run: async (payload: AgentTurnPayload, params) => {
    // `params.signal` is Trigger's own abort signal for this attempt - already wired to
    // cancellation and to maxDuration expiry by the platform, so it is used directly as the
    // loop's cooperative-cancellation signal rather than layering a second AbortController on
    // top of it.
    const { deps, snapshot } = await buildRunDeps({ runId: payload.runId, triggerRunId: params.ctx.run.id, signal: params.signal });
    await emitAgentStarted(snapshot);
    const outcome = await runAgentTurn(payload.runId, deps);
    await emitAgentTerminal(snapshot, outcome);
    await deps.realtime.flush();
    return outcome;
  },

  onFailure: async ({ payload, error }) => {
    await finalizeBestEffort(payload.runId, "failed", error);
  },

  onCancel: async ({ payload, runPromise }) => {
    // Give the loop's own cancellation-finalization path (driven by the same AbortSignal /
    // store.isCancelRequested polling) a brief window to land on its own before forcing one.
    // A clean RESOLVE means the loop's own finalize() ran; a REJECT means it very likely didn't
    // (e.g. it threw before reaching its own finally-style cleanup), so it must not be treated
    // the same as "settled" - store.finalize is idempotent, so finalizing again here is safe
    // either way, but skipping it on a reject would risk leaving the run stuck active.
    const outcome = await Promise.race([
      runPromise.then(() => "resolved" as const).catch(() => "rejected" as const),
      sleep(2_000).then(() => "timeout" as const),
    ]);
    if (outcome === "resolved") return;
    await finalizeBestEffort(payload.runId, "cancelled");
  },
});
