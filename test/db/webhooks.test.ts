import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", () => ({
  default: { promises: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) } },
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: `trg_${crypto.randomUUID()}` })) },
}));

import { tasks } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createEndpoint, deleteEndpoint, emitWebhookEvent, listEndpoints } from "@/services/webhooks";
import { createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe("webhooks service: endpoint CRUD", () => {
  it("create returns the secret once; list hides it", async () => {
    const user = await createUser();
    const created = await createEndpoint(user.id, { url: "https://example.com/hook", events: ["agent.completed"] });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.active).toBe(true);
    expect(created.events).toEqual(["agent.completed"]);

    const list = await listEndpoints(user.id);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(created.id);
    expect(list.items[0]?.secret).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(list.items[0] ?? {}, "secret")).toBe(false);
  });

  it("delete is idempotent: repeat delete by the owner, and delete of a never-existed id, both succeed silently", async () => {
    const user = await createUser();
    const created = await createEndpoint(user.id, { url: "https://example.com/hook", events: ["agent.completed"] });

    await deleteEndpoint(user.id, created.id);
    await expect(deleteEndpoint(user.id, created.id)).resolves.toBeUndefined();
    await expect(deleteEndpoint(user.id, "cl_does_not_exist")).resolves.toBeUndefined();

    const list = await listEndpoints(user.id);
    expect(list.items).toHaveLength(0);
  });

  it("cross-user delete is not_found and leaves the endpoint intact", async () => {
    const owner = await createUser();
    const other = await createUser();
    const created = await createEndpoint(owner.id, { url: "https://example.com/hook", events: ["agent.completed"] });

    await expect(deleteEndpoint(other.id, created.id)).rejects.toBeInstanceOf(AppError);
    await expect(deleteEndpoint(other.id, created.id)).rejects.toMatchObject({ code: "not_found" });

    const list = await listEndpoints(owner.id);
    expect(list.items).toHaveLength(1);
  });

  it("rejects a non-https URL via the SSRF guard (validation_error)", async () => {
    const user = await createUser();
    await expect(createEndpoint(user.id, { url: "http://example.com/hook", events: ["agent.completed"] })).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("emitWebhookEvent", () => {
  it("creates deliveries only for ACTIVE endpoints subscribed to the event type, with idempotencyKey `<endpointId>:<eventId>`, and triggers webhook-deliver once per delivery", async () => {
    const user = await createUser();
    const subscribed = await createEndpoint(user.id, { url: "https://example.com/hook-a", events: ["agent.completed"] });
    await createEndpoint(user.id, { url: "https://example.com/hook-b", events: ["agent.failed"] }); // different event type
    const inactive = await createEndpoint(user.id, { url: "https://example.com/hook-c", events: ["agent.completed"] });
    await prisma.webhookEndpoint.update({ where: { id: inactive.id }, data: { active: false } });

    await emitWebhookEvent({ userId: user.id, type: "agent.completed", data: { runId: "run_1", chatId: "chat_1", status: "completed" }, eventId: "evt_fixed_1" });

    const allDeliveries = await prisma.webhookDelivery.findMany();
    expect(allDeliveries).toHaveLength(1);
    expect(allDeliveries[0]?.endpointId).toBe(subscribed.id);
    expect(allDeliveries[0]?.idempotencyKey).toBe(`${subscribed.id}:evt_fixed_1`);
    expect(allDeliveries[0]?.status).toBe("PENDING");
    expect((allDeliveries[0]?.payload as { data: { runId: string } }).data.runId).toBe("run_1");

    expect(tasks.trigger).toHaveBeenCalledTimes(1);
    expect(tasks.trigger).toHaveBeenCalledWith("webhook-deliver", { deliveryId: allDeliveries[0]?.id }, { idempotencyKey: allDeliveries[0]?.id });
  });

  it("emitting the same event id twice does not duplicate deliveries or re-trigger delivery, per endpoint", async () => {
    const user = await createUser();
    // Two endpoints subscribed to prove the dedupe is per-(endpoint,event) - not "only the first
    // endpoint ever gets a delivery" - while still asserting the P2002-on-idempotencyKey path is
    // actually what skips the second call (each endpoint gets exactly one delivery, not zero).
    const endpointA = await createEndpoint(user.id, { url: "https://example.com/hook-a", events: ["tool.completed"] });
    const endpointB = await createEndpoint(user.id, { url: "https://example.com/hook-b", events: ["tool.completed"] });

    const createSpy = vi.spyOn(prisma.webhookDelivery, "create");
    const args = { userId: user.id, type: "tool.completed" as const, data: { runId: null, chatId: null, status: "completed" }, eventId: "evt_dup_1" };
    await emitWebhookEvent(args);
    await emitWebhookEvent(args);

    const deliveriesA = await prisma.webhookDelivery.findMany({ where: { endpointId: endpointA.id } });
    const deliveriesB = await prisma.webhookDelivery.findMany({ where: { endpointId: endpointB.id } });
    expect(deliveriesA).toHaveLength(1);
    expect(deliveriesB).toHaveLength(1);
    expect(tasks.trigger).toHaveBeenCalledTimes(2); // one per endpoint, not per emit call

    // Proves the loop actually CONTINUES past a per-endpoint unique violation (the isUniqueViolation
    // catch), rather than the second emit call aborting after its first endpoint throws: both
    // endpoints were attempted on both calls, even though two of the four attempts hit P2002.
    expect(createSpy).toHaveBeenCalledTimes(4);
    createSpy.mockRestore();
  });

  it("is a no-op (never calls tasks.trigger) when the user has no endpoints registered", async () => {
    const user = await createUser();
    await expect(
      emitWebhookEvent({ userId: user.id, type: "agent.started", data: { runId: "run_1", chatId: "chat_1", status: "running" } }),
    ).resolves.toBeUndefined();
    expect(tasks.trigger).not.toHaveBeenCalled();
  });

  it("a Trigger dispatch error inside emit does not propagate to the caller", async () => {
    const user = await createUser();
    await createEndpoint(user.id, { url: "https://example.com/hook", events: ["agent.started"] });
    vi.mocked(tasks.trigger).mockRejectedValueOnce(new Error("trigger service down"));

    await expect(
      emitWebhookEvent({ userId: user.id, type: "agent.started", data: { runId: "run_1", chatId: "chat_1", status: "running" } }),
    ).resolves.toBeUndefined();

    // The delivery row was still created even though dispatch failed - it can be redelivered later.
    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
  });

  it("a Prisma error while creating a delivery row does not propagate to the caller", async () => {
    const user = await createUser();
    await createEndpoint(user.id, { url: "https://example.com/hook", events: ["agent.started"] });
    const createSpy = vi.spyOn(prisma.webhookDelivery, "create").mockRejectedValueOnce(new Error("db exploded"));

    await expect(
      emitWebhookEvent({ userId: user.id, type: "agent.started", data: { runId: "run_1", chatId: "chat_1", status: "running" } }),
    ).resolves.toBeUndefined();

    createSpy.mockRestore();
  });
});
