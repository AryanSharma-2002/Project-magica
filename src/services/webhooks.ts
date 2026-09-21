import { randomBytes, randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk";
import {
  CreateWebhookRequest,
  ListWebhooksResponse,
  WebhookEndpoint as WebhookEndpointContract,
  WebhookEvent as WebhookEventContract,
  type WebhookEventType,
} from "@agent-chat/contracts";
import type { webhookDeliverTask } from "@/trigger/webhook-deliver.task";
import { prisma, isUniqueViolation, Prisma } from "@/lib/db";
import { errors } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { assertDeliverableUrl } from "@/lib/webhooks/url-guard";
import { assertChatMutationRateLimit } from "@/lib/rate-limit";

/** Per-user cap: every event fans out to every subscribed endpoint, so this bounds the amplification one account can cause. */
export const MAX_WEBHOOK_ENDPOINTS_PER_USER = 10;
import type { WebhookEndpoint as DbWebhookEndpoint } from "@/generated/prisma/client";

/**
 * Webhook endpoint management + best-effort event emission (ARCHITECTURE.md §9 "Webhooks:"
 * paragraph). Emission is intentionally decoupled from delivery: this module only creates
 * `WebhookDelivery` rows and dispatches the `webhook-deliver` task; the task (src/trigger/webhook-deliver.task.ts)
 * owns the HTTP POST, signing, and retry bookkeeping.
 */

function serializeEndpoint(row: DbWebhookEndpoint, opts: { includeSecret: boolean }): WebhookEndpointContract {
  return WebhookEndpointContract.parse({
    id: row.id,
    url: row.url,
    events: row.events,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    ...(opts.includeSecret ? { secret: row.secret } : {}),
  });
}

/** Returns the endpoint WITH its plaintext secret - the only response that ever includes it. */
export async function createEndpoint(userId: string, body: CreateWebhookRequest): Promise<WebhookEndpointContract> {
  await assertChatMutationRateLimit(userId);
  await assertDeliverableUrl(body.url);
  const existing = await prisma.webhookEndpoint.count({ where: { userId } });
  if (existing >= MAX_WEBHOOK_ENDPOINTS_PER_USER) {
    throw errors.validation(`At most ${MAX_WEBHOOK_ENDPOINTS_PER_USER} webhook endpoints per account`, { reason: "too_many_endpoints", max: MAX_WEBHOOK_ENDPOINTS_PER_USER });
  }

  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const row = await prisma.webhookEndpoint.create({
    data: { userId, url: body.url, events: body.events, secret },
  });
  return serializeEndpoint(row, { includeSecret: true });
}

export async function listEndpoints(userId: string): Promise<ListWebhooksResponse> {
  const rows = await prisma.webhookEndpoint.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return ListWebhooksResponse.parse({ items: rows.map((row) => serializeEndpoint(row, { includeSecret: false })) });
}

/**
 * Idempotent: deleting an endpoint that no longer exists (e.g. a repeated call) is a silent
 * success. An endpoint that exists but belongs to another user is reported as `not_found` so
 * existence is never leaked.
 */
export async function deleteEndpoint(userId: string, endpointId: string): Promise<void> {
  const row = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!row) return;
  if (row.userId !== userId) throw errors.notFound("Webhook endpoint");
  // deleteMany (not delete): a concurrent duplicate call for the same owner must stay a no-op
  // (count 0) rather than throw P2025 "record not found" on the loser of the race.
  await prisma.webhookEndpoint.deleteMany({ where: { id: endpointId, userId } });
}

export type EmitWebhookEventArgs = {
  userId: string;
  type: WebhookEventType;
  data: WebhookEventContract["data"];
  /** Test-only: pin the event id to exercise idempotent-emit-twice behavior deterministically. Production always omits this (fresh id per call). */
  eventId?: string;
  /** Test-only: injectable clock. */
  now?: () => Date;
};

/**
 * Fans a domain event out to every ACTIVE endpoint subscribed to it: one `WebhookDelivery` row
 * per endpoint (idempotencyKey `<endpointId>:<eventId>`), then dispatches `webhook-deliver` for
 * each. BEST-EFFORT: every failure (bad input, DB error, dispatch error) is caught and logged
 * here - a webhook problem must never fail the run/tool invocation that triggered it.
 */
export async function emitWebhookEvent(args: EmitWebhookEventArgs): Promise<void> {
  const log = logger({ userId: args.userId });
  try {
    const now = args.now ?? (() => new Date());
    const event = WebhookEventContract.parse({
      id: args.eventId ?? `evt_${randomUUID()}`,
      type: args.type,
      createdAt: now().toISOString(),
      data: args.data,
    });

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { userId: args.userId, active: true, events: { has: args.type } },
    });
    if (endpoints.length === 0) return;

    for (const endpoint of endpoints) {
      const idempotencyKey = `${endpoint.id}:${event.id}`;
      let delivery: { id: string };
      try {
        delivery = await prisma.webhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            eventType: event.type,
            payload: event as unknown as Prisma.InputJsonValue,
            idempotencyKey,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err, "idempotencyKey")) {
          log.warn({ idempotencyKey }, "webhook delivery already exists for this event; skipping duplicate");
          continue;
        }
        throw err;
      }

      try {
        await tasks.trigger<typeof webhookDeliverTask>("webhook-deliver", { deliveryId: delivery.id }, { idempotencyKey: delivery.id });
      } catch (err) {
        log.error({ err, deliveryId: delivery.id }, "emitWebhookEvent: failed to dispatch webhook-deliver task");
      }
    }
  } catch (err) {
    log.error({ err, type: args.type }, "emitWebhookEvent: best-effort emission failed");
  }
}
