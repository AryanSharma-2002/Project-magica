import type { JsonValue, SafeError } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import type { DurableExecutor } from "@/agent/loop/ports";
import { magicaToolTask, type MagicaToolResult } from "@/trigger/magica-tool.task";

/**
 * DurableExecutor over the magica-tool child task (ARCHITECTURE.md §5.3). `triggerAndWait`
 * resolves a TWO-LAYER result:
 *   1) the Trigger dispatch/execution envelope: { ok, output } | { ok: false, error: unknown }
 *      (unknown here means the child task itself crashed/threw - it normally never does).
 *   2) our own child payload (the `output` above): { ok: true, ... } | { ok: false, error: SafeError }
 *      which the child always returns instead of throwing (ARCHITECTURE: "never throw across the
 *      boundary").
 * Both layers are unwrapped into a single AppError-or-result outcome here.
 */
export function createDurableExecutor(): DurableExecutor {
  return {
    async execute({ invocationId, input }) {
      // The parent's validated input rides along in the payload: the DB row holds the display-
      // sanitized copy (merge_videos truncates long URL arrays), which must never be re-executed.
      const dispatched = await magicaToolTask.triggerAndWait(
        { invocationId, input: input as JsonValue },
        { idempotencyKey: invocationId, idempotencyKeyTTL: "24h" },
      );

      if (!dispatched.ok) {
        throw new AppError("provider_unavailable", "The media tool run could not be completed", {
          retryable: true,
          cause: dispatched.error,
        });
      }

      const child: MagicaToolResult = dispatched.output;
      if (!child.ok) {
        const safe: SafeError = child.error;
        throw new AppError(safe.code, safe.message, { retryable: safe.retryable, details: safe.details });
      }

      return {
        output: child.output,
        ...(child.providerRunId ? { providerRunId: child.providerRunId } : {}),
        microcreditsCharged: child.microcreditsCharged,
        durationMs: child.durationMs,
      };
    },
  };
}
