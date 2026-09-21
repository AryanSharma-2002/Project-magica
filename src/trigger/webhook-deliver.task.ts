import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { WebhookDeliveryStatus } from "@/generated/prisma/enums";
import { signWebhookPayload } from "@/lib/webhooks/signature";
import { assertDeliverableUrl } from "@/lib/webhooks/url-guard";

/**
 * Delivers one WebhookDelivery row (ARCHITECTURE.md §9 "Webhooks:" paragraph). Triggered from
 * `emitWebhookEvent` (src/services/webhooks.ts) via `tasks.trigger("webhook-deliver", { deliveryId },
 * { idempotencyKey: deliveryId })`. Deliberately does NOT import services/webhooks.ts - it only
 * needs prisma + the signature helper, and pulling in a module that imports `tasks` from
 * `@trigger.dev/sdk` would break every existing test that mocks that module without a `tasks` export.
 */

export type WebhookDeliverPayload = { deliveryId: string };

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 600_000;
const BACKOFF_FACTOR = 2;
const RESPONSE_BODY_SNIPPET_LENGTH = 200;
const FETCH_TIMEOUT_MS = 10_000;

/** Exponential backoff for the attempt that just failed: 5s, 10s, 20s, ..., capped at 10min. Trigger's own `retry` config (factor 2, min 5s, max 10min, randomize) governs *when* the platform actually retries; this value is stored on the row for observability/`nextAttemptAt`. */
function nextBackoffDelayMs(attemptNumber: number): number {
  const delay = BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attemptNumber - 1));
  return Math.min(delay, MAX_DELAY_MS);
}

/** Reads at most `limit` bytes of a response body and cancels the rest, so a hostile receiver cannot make the worker buffer an unbounded error body. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* a body read error is not worth failing the bookkeeping over */
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, limit);
}

export const webhookDeliverTask = task({
  id: "webhook-deliver",
  maxDuration: 60,
  retry: { maxAttempts: 6, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 600_000, randomize: true },

  run: async (payload: WebhookDeliverPayload, params) => {
    const log = logger({ triggerRunId: params.ctx.run.id });

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: payload.deliveryId } });
    if (!delivery) {
      log.warn({ deliveryId: payload.deliveryId }, "webhook-deliver: delivery row not found; skipping");
      return;
    }
    if (delivery.status === WebhookDeliveryStatus.DELIVERED) {
      return; // idempotent replay: already delivered, never re-POST
    }

    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (!endpoint || !endpoint.active) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.FAILED, lastError: endpoint ? "Endpoint is inactive" : "Endpoint was deleted" },
      });
      return;
    }

    // Re-validate the URL at delivery time, not only at registration: a hostname's records can be
    // changed (DNS rebinding) between the two. This re-resolves and re-classifies right before the
    // connect, narrowing the window to the resolution itself. Redirects are never followed below.
    try {
      await assertDeliverableUrl(endpoint.url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.FAILED, attempts: delivery.attempts + 1, lastError: `Endpoint URL rejected at delivery time: ${reason}`.slice(0, 500) },
      });
      log.warn({ deliveryId: delivery.id }, "webhook-deliver: endpoint URL failed re-validation; delivery marked FAILED");
      return;
    }

    const rawBody = JSON.stringify(delivery.payload);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(endpoint.secret, rawBody, timestampSeconds);

    let response: Response | undefined;
    let networkError: unknown;
    try {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-AgentChat-Signature": signature,
          "X-AgentChat-Event": delivery.eventType,
          "X-AgentChat-Delivery": delivery.id,
          "user-agent": "agent-chat-webhooks/1",
        },
        body: rawBody,
        // A receiver has no legitimate reason to redirect; following one would let a public URL
        // bounce the signed POST (downgraded to GET on 302) at an internal address.
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      networkError = err;
    }

    const attempts = delivery.attempts + 1;

    if (response?.ok) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.DELIVERED, attempts, lastError: null, nextAttemptAt: null },
      });
      return;
    }

    let lastError: string;
    if (response) {
      const bodyText = await readBounded(response, RESPONSE_BODY_SNIPPET_LENGTH);
      lastError = `${response.status}${response.status >= 300 && response.status < 400 ? " (redirects are not followed)" : ""} ${bodyText}`.trim();
    } else {
      lastError = networkError instanceof Error ? networkError.message : String(networkError);
    }

    const nextAttemptAt = new Date(Date.now() + nextBackoffDelayMs(params.ctx.attempt.number));
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: WebhookDeliveryStatus.PENDING, attempts, lastError, nextAttemptAt },
    });

    // Never log the endpoint secret; `lastError` above is only the response status/body or the fetch error message.
    throw new Error(`webhook delivery failed: ${lastError}`);
  },

  onFailure: async ({ payload }) => {
    // Retries exhausted (or a non-retryable crash). A row already DELIVERED by a prior attempt
    // (shouldn't happen given the run() short-circuit above, but never regress a terminal success).
    await prisma.webhookDelivery.updateMany({
      where: { id: payload.deliveryId, status: { not: WebhookDeliveryStatus.DELIVERED } },
      data: { status: WebhookDeliveryStatus.FAILED },
    });
  },
});
