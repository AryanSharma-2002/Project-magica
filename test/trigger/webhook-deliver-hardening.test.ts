import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
}));

const guard = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock("@/lib/webhooks/url-guard", () => ({
  assertDeliverableUrl: (url: string) => guard(url),
}));

import { prisma } from "@/lib/db";
import { createUser, resetDb } from "../helpers/db";
import type { WebhookDeliverPayload } from "@/trigger/webhook-deliver.task";

const { webhookDeliverTask: exported } = await import("@/trigger/webhook-deliver.task");
type FakeTaskParams = { ctx: { run: { id: string }; attempt: { number: number } }; signal: AbortSignal };
const webhookDeliverTask = exported as unknown as { run: (payload: WebhookDeliverPayload, params: FakeTaskParams) => Promise<void> };
const params: FakeTaskParams = { ctx: { run: { id: "trun_h" }, attempt: { number: 1 } }, signal: new AbortController().signal };

async function seed(userId: string) {
  const endpoint = await prisma.webhookEndpoint.create({ data: { userId, url: "https://receiver.example.com/hook", secret: "whsec_h", events: ["agent.completed"] } });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      eventType: "agent.completed",
      payload: { id: "evt_h", type: "agent.completed", createdAt: "2026-09-21T00:00:00.000Z", data: { runId: "r", chatId: "c", status: "completed" } } as never,
      idempotencyKey: `${endpoint.id}:evt_h`,
    },
  });
  return { endpoint, delivery };
}

beforeEach(async () => {
  await resetDb();
  vi.unstubAllGlobals();
  guard.mockReset();
  guard.mockResolvedValue(undefined);
});

/** Security review 2026-09-21: redirect following, delivery-time re-validation, bounded error bodies. */
describe("webhook-deliver hardening", () => {
  it("never follows a redirect: a 302 is a failed attempt and fetch is called with redirect: manual", async () => {
    const user = await createUser();
    const { delivery } = await seed(user.id);
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(webhookDeliverTask.run({ deliveryId: delivery.id }, params)).rejects.toThrow(/302/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("redirects are not followed");
  });

  it("re-validates the endpoint URL at delivery time and marks the delivery FAILED without connecting when it is rejected", async () => {
    const user = await createUser();
    const { delivery, endpoint } = await seed(user.id);
    guard.mockRejectedValueOnce(new Error("Webhook URL resolves to a disallowed address"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await webhookDeliverTask.run({ deliveryId: delivery.id }, params);

    expect(guard).toHaveBeenCalledWith(endpoint.url);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("rejected at delivery time");
  });

  it("reads at most a bounded snippet of a failing response body", async () => {
    const user = await createUser();
    const { delivery } = await seed(user.id);
    const huge = "x".repeat(5 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(huge, { status: 500 })));

    await expect(webhookDeliverTask.run({ deliveryId: delivery.id }, params)).rejects.toThrow(/500/);

    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect((row.lastError ?? "").length).toBeLessThanOrEqual(260);
  });
});
