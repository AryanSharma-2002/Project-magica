import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
}));
// The task re-validates the endpoint URL right before connecting (DNS rebinding guard); these tests
// use a fake public hostname, so the guard's real DNS lookup is stubbed out here. The guard itself is
// covered by test/webhooks/url-guard*.test.ts and the rejection path by webhook-deliver-hardening.test.ts.
vi.mock("@/lib/webhooks/url-guard", () => ({
  assertDeliverableUrl: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/webhooks/signature";
import { createUser, resetDb } from "../helpers/db";
import type { WebhookDeliverPayload } from "@/trigger/webhook-deliver.task";

/**
 * Deliberately does NOT go through src/services/webhooks.ts (createEndpoint / emitWebhookEvent) -
 * those would run the SSRF guard (real DNS) and require mocking `tasks.trigger` too. Rows are
 * inserted directly, mirroring test/trigger/magica-tool-task.test.ts's approach to the child task.
 */
const { webhookDeliverTask: webhookDeliverTaskExport } = await import("@/trigger/webhook-deliver.task");

type FakeTaskParams = { ctx: { run: { id: string }; attempt: { number: number } }; signal: AbortSignal };
const webhookDeliverTask = webhookDeliverTaskExport as unknown as {
  run: (payload: WebhookDeliverPayload, params: FakeTaskParams) => Promise<void>;
  onFailure: (args: { payload: WebhookDeliverPayload }) => Promise<void>;
};

function fakeParams(attemptNumber = 1): FakeTaskParams {
  return { ctx: { run: { id: "trun_wh_1" }, attempt: { number: attemptNumber } }, signal: new AbortController().signal };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function createEndpointRow(userId: string, overrides: Partial<{ url: string; secret: string; active: boolean; events: string[] }> = {}) {
  return prisma.webhookEndpoint.create({
    data: {
      userId,
      url: overrides.url ?? "https://receiver.example.com/hook",
      secret: overrides.secret ?? "whsec_test_secret",
      events: overrides.events ?? ["agent.completed"],
      active: overrides.active ?? true,
    },
  });
}

async function createDeliveryRow(
  endpointId: string,
  overrides: Partial<{ eventType: string; payload: unknown; status: "PENDING" | "DELIVERED" | "FAILED"; attempts: number; idempotencyKey: string }> = {},
) {
  return prisma.webhookDelivery.create({
    data: {
      endpointId,
      eventType: overrides.eventType ?? "agent.completed",
      payload: (overrides.payload ??
        { id: "evt_1", type: "agent.completed", createdAt: "2026-09-21T00:00:00.000Z", data: { runId: "run_1", chatId: "chat_1", status: "completed" } }) as never,
      status: overrides.status ?? "PENDING",
      attempts: overrides.attempts ?? 0,
      idempotencyKey: overrides.idempotencyKey ?? `${endpointId}:evt_1`,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.unstubAllGlobals();
});

describe("webhook-deliver task", () => {
  it("200 -> DELIVERED, one attempt, a valid signature, and the three X-AgentChat-* headers", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await webhookDeliverTask.run({ deliveryId: delivery.id }, fakeParams());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint.url);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-AgentChat-Event"]).toBe("agent.completed");
    expect(headers["X-AgentChat-Delivery"]).toBe(delivery.id);
    expect(headers["user-agent"]).toBe("agent-chat-webhooks/1");

    const rawBody = String(init.body);
    expect(verifyWebhookSignature(endpoint.secret, rawBody, headers["X-AgentChat-Signature"])).toBe(true);
    // Wrong secret must not verify - proves the signature is actually keyed off the endpoint's secret.
    expect(verifyWebhookSignature("whsec_wrong", rawBody, headers["X-AgentChat-Signature"])).toBe(false);

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("DELIVERED");
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBeNull();
  });

  it("500 -> throws (so Trigger retries), attempts: 1, lastError set, status still PENDING", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id);

    const fetchMock = vi.fn().mockResolvedValue(new Response("server exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(webhookDeliverTask.run({ deliveryId: delivery.id }, fakeParams(1))).rejects.toThrow();

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("PENDING");
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toContain("500");
    expect(updated.lastError).toContain("server exploded");
    expect(updated.nextAttemptAt).not.toBeNull();
  });

  it("a network/fetch error -> throws, attempts: 1, lastError is the error message", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id);

    const fetchMock = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(webhookDeliverTask.run({ deliveryId: delivery.id }, fakeParams(1))).rejects.toThrow();

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("PENDING");
    expect(updated.lastError).toContain("ENOTFOUND");
  });

  it("replay of a DELIVERED delivery makes no HTTP call and leaves the row unchanged", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id, { status: "DELIVERED", attempts: 1 });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await webhookDeliverTask.run({ deliveryId: delivery.id }, fakeParams());

    expect(fetchMock).not.toHaveBeenCalled();
    const unchanged = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(unchanged.attempts).toBe(1);
    expect(unchanged.status).toBe("DELIVERED");
  });

  it("an inactive endpoint marks the delivery FAILED without an HTTP call", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id, { active: false });
    const delivery = await createDeliveryRow(endpoint.id);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await webhookDeliverTask.run({ deliveryId: delivery.id }, fakeParams());

    expect(fetchMock).not.toHaveBeenCalled();
    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("FAILED");
  });

  it("a delivery row that no longer exists (endpoint cascade-deleted) is skipped gracefully", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(webhookDeliverTask.run({ deliveryId: "does-not-exist" }, fakeParams())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("onFailure marks the delivery FAILED once retries are exhausted", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id, { attempts: 6, status: "PENDING" });

    await webhookDeliverTask.onFailure({ payload: { deliveryId: delivery.id } });

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("FAILED");
  });

  it("onFailure never regresses an already-DELIVERED row", async () => {
    const user = await createUser();
    const endpoint = await createEndpointRow(user.id);
    const delivery = await createDeliveryRow(endpoint.id, { status: "DELIVERED", attempts: 1 });

    await webhookDeliverTask.onFailure({ payload: { deliveryId: delivery.id } });

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("DELIVERED");
  });
});
