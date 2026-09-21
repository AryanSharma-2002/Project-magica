import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: `trg_${crypto.randomUUID()}` })) },
}));

import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { tasks } from "@trigger.dev/sdk";
import { getToolRun, startToolRun } from "@/services/public";
import { createUser, resetDb } from "../helpers/db";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CROP_INPUT = { image_url: "https://cdn.example.com/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 };

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  // crop_image's estimate() hits POST /v1/nodes/estimate-credits; stub it so tests never touch
  // the real network and always get a deterministic estimate.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { estimates: [{ microcredits: 5000 }] })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startToolRun", () => {
  it("an unknown tool name is not_found", async () => {
    const user = await createUser();
    await expect(startToolRun(user.id, "not_a_real_tool", { input: {} })).rejects.toMatchObject({ code: "not_found" });
    expect(tasks.trigger).not.toHaveBeenCalled();
  });

  it("a registered but non-Magica (inline) tool is not_found", async () => {
    const user = await createUser();
    await expect(startToolRun(user.id, "load_skill", { input: { name: "image-generation" } })).rejects.toMatchObject({ code: "not_found" });
  });

  it("malformed input is malformed_tool_call", async () => {
    const user = await createUser();
    await expect(startToolRun(user.id, "crop_image", { input: { image_url: "not-a-url" } })).rejects.toMatchObject({ code: "malformed_tool_call" });
  });

  it("happy path: PENDING invocation with runId null, a RESERVE ledger entry, and dispatches the tool-run task", async () => {
    const user = await createUser();

    const res = await startToolRun(user.id, "crop_image", { input: CROP_INPUT });

    expect(res.status).toBe("pending");
    expect(res.statusUrl).toBe(`${getEnv().PUBLIC_API_BASE_URL}/api/v1/tools/runs/${res.invocationId}`);

    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: res.invocationId } });
    expect(row.runId).toBeNull();
    expect(row.messageId).toBeNull();
    expect(row.status).toBe("PENDING");
    expect(row.toolName).toBe("crop_image");
    expect(row.microcreditsEstimated).toBe(5000n);
    expect(row.toolCallId.startsWith("pub_")).toBe(true);

    const reservation = await prisma.creditLedger.findUniqueOrThrow({ where: { idempotencyKey: `reserve:${res.invocationId}` } });
    expect(reservation.amount).toBe(-5000n);
    expect(reservation.runId).toBeNull();
    expect(reservation.toolInvocationId).toBe(res.invocationId);
    expect(reservation.type).toBe("RESERVE");

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.creditBalance).toBe(1_000_000_000n - 5_000n);

    expect(tasks.trigger).toHaveBeenCalledTimes(1);
    expect(tasks.trigger).toHaveBeenCalledWith(
      "tool-run",
      { invocationId: res.invocationId, input: expect.objectContaining({ image_url: CROP_INPUT.image_url }) },
      { idempotencyKey: res.invocationId },
    );
  });

  it("insufficient balance: insufficient_credits and no invocation is persisted", async () => {
    const user = await createUser({ creditBalance: 0n });

    await expect(startToolRun(user.id, "crop_image", { input: CROP_INPUT })).rejects.toMatchObject({ code: "insufficient_credits" });

    const count = await prisma.toolInvocation.count({ where: { userId: user.id } });
    expect(count).toBe(0);
    const ledgerCount = await prisma.creditLedger.count({ where: { userId: user.id, type: "RESERVE" } });
    expect(ledgerCount).toBe(0);
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
});

describe("getToolRun", () => {
  it("owner check: another user's invocation is not_found, the owner can read it", async () => {
    const owner = await createUser();
    const other = await createUser();
    const res = await startToolRun(owner.id, "crop_image", { input: CROP_INPUT });

    await expect(getToolRun(other.id, res.invocationId)).rejects.toMatchObject({ code: "not_found" });

    const fetched = await getToolRun(owner.id, res.invocationId);
    expect(fetched.id).toBe(res.invocationId);
    expect(fetched.status).toBe("pending");
    expect(fetched.runId).toBeNull();
    expect(fetched.microcreditsEstimated).toBe(5000);
  });

  it("a nonexistent invocation id is not_found", async () => {
    const user = await createUser();
    await expect(getToolRun(user.id, "nonexistent")).rejects.toMatchObject({ code: "not_found" });
  });
});
