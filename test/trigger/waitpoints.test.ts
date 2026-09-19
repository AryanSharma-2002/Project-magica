import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { truncateAll, createTestRun, createTestToolInvocation } from "../db-helpers";

vi.mock("@trigger.dev/sdk", () => ({
  wait: { createToken: vi.fn(), forToken: vi.fn(), completeToken: vi.fn() },
}));

const { wait } = (await import("@trigger.dev/sdk")) as unknown as {
  wait: { createToken: ReturnType<typeof vi.fn>; forToken: ReturnType<typeof vi.fn> };
};
const { createWaitpointPort } = await import("@/trigger/adapters/waitpoints");

function fakeRealtime() {
  return { text: vi.fn(), metadata: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
}

describe("WaitpointPort", () => {
  beforeEach(async () => {
    await truncateAll();
    wait.createToken.mockReset();
    wait.forToken.mockReset();
  });

  it("resolved: creates the token + row with a stable (non-timestamped) idempotency key, returns the resolution", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "gpt_image_2" });
    wait.createToken.mockResolvedValue({ id: "tok_1", isCached: false, url: "https://x" });
    wait.forToken.mockResolvedValue({ ok: true, output: { resolution: { type: "approval", approved: true } } });

    const realtime = fakeRealtime();
    const port = createWaitpointPort({ realtime });
    const result = await port.ask({
      runId: run.id,
      toolInvocationId: invocation.id,
      type: "approval",
      prompt: { type: "approval", title: "Approve?", toolName: "gpt_image_2", toolCallId: "call_1", input: {}, microcreditsEstimated: 1000 },
      timeoutSeconds: 600,
    });

    expect(result.outcome).toEqual({ kind: "resolved", resolution: { type: "approval", approved: true } });
    expect(wait.createToken).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `wp:${run.id}:${invocation.id}`, timeout: "600s" }));
    // No Date.now() suffix anywhere in the key - stable across retries of the same ask.
    const key = wait.createToken.mock.calls[0]?.[0]?.idempotencyKey as string;
    expect(key).not.toMatch(/\d{13}/);

    const row = await prisma.waitpoint.findUnique({ where: { triggerTokenId: "tok_1" } });
    expect(row).toMatchObject({ runId: run.id, toolInvocationId: invocation.id, type: "APPROVAL", status: "PENDING" });
    expect(realtime.metadata).toHaveBeenCalledWith(expect.objectContaining({ waitpoint: expect.objectContaining({ id: result.waitpointId, status: "pending" }) }));
  });

  it("cancelled: maps { cancelled: true } to a cancelled outcome without touching the row's status", async () => {
    const { run } = await createTestRun();
    wait.createToken.mockResolvedValue({ id: "tok_2", isCached: false, url: "https://x" });
    wait.forToken.mockResolvedValue({ ok: true, output: { cancelled: true } });

    const port = createWaitpointPort({ realtime: fakeRealtime() });
    const result = await port.ask({ runId: run.id, toolInvocationId: null, type: "approval", prompt: { type: "approval", title: "Approve?", toolName: "crop_image", toolCallId: "c1", input: {}, microcreditsEstimated: 1 }, timeoutSeconds: 60 });

    expect(result.outcome).toEqual({ kind: "cancelled" });
    const row = await prisma.waitpoint.findUnique({ where: { triggerTokenId: "tok_2" } });
    expect(row?.status).toBe("PENDING");
  });

  it("expired: wait.forToken timing out transitions the row PENDING -> EXPIRED", async () => {
    const { run } = await createTestRun();
    wait.createToken.mockResolvedValue({ id: "tok_3", isCached: false, url: "https://x" });
    wait.forToken.mockResolvedValue({ ok: false, error: new Error("timed out") });

    const port = createWaitpointPort({ realtime: fakeRealtime() });
    const result = await port.ask({ runId: run.id, toolInvocationId: null, type: "plan", prompt: { type: "plan", title: "Plan", steps: [{ id: "s1", title: "Step 1" }] }, timeoutSeconds: 60 });

    expect(result.outcome).toEqual({ kind: "expired" });
    const row = await prisma.waitpoint.findUnique({ where: { triggerTokenId: "tok_3" } });
    expect(row?.status).toBe("EXPIRED");
  });

  it("isCached: reuses the existing row instead of creating a duplicate for the same triggerTokenId", async () => {
    const { run } = await createTestRun();
    await prisma.waitpoint.create({
      data: {
        runId: run.id,
        toolInvocationId: null,
        type: "APPROVAL",
        status: "PENDING",
        triggerTokenId: "tok_reused",
        prompt: { type: "approval", title: "Approve?", toolName: "crop_image", toolCallId: "c1", input: {}, microcreditsEstimated: 1 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    wait.createToken.mockResolvedValue({ id: "tok_reused", isCached: true, url: "https://x" });
    wait.forToken.mockResolvedValue({ ok: true, output: { resolution: { type: "approval", approved: false } } });

    const port = createWaitpointPort({ realtime: fakeRealtime() });
    await port.ask({ runId: run.id, toolInvocationId: null, type: "approval", prompt: { type: "approval", title: "Approve?", toolName: "crop_image", toolCallId: "c1", input: {}, microcreditsEstimated: 1 }, timeoutSeconds: 60 });

    const rows = await prisma.waitpoint.findMany({ where: { triggerTokenId: "tok_reused" } });
    expect(rows).toHaveLength(1);
  });
});
