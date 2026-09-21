import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { reserveInvocation, settleInvocation } from "@/lib/credits";
import { truncateAll, createTestUser } from "../db-helpers";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
}));

vi.mock("@/trigger/magica-tool.task", () => ({
  magicaToolTask: { triggerAndWait: vi.fn() },
}));

const { toolRunTask: toolRunTaskExport } = await import("@/trigger/tool-run.task");
const { magicaToolTask } = await import("@/trigger/magica-tool.task");

type FakeTaskParams = { ctx: { run: { id: string } }; signal: AbortSignal };
type ToolRunPayload = { invocationId: string; input: unknown };
const toolRunTask = toolRunTaskExport as unknown as { run: (payload: ToolRunPayload, params: FakeTaskParams) => Promise<void> };
const triggerAndWait = magicaToolTask.triggerAndWait as unknown as ReturnType<typeof vi.fn>;

function fakeParams(triggerRunId = "trun_1"): FakeTaskParams {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

async function makeInvocation(overrides: Partial<{ status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED"; microcreditsCharged: bigint }> = {}) {
  const user = await createTestUser();
  await prisma.user.update({ where: { id: user.id }, data: { creditBalance: 1_000_000n } });
  const invocation = await prisma.toolInvocation.create({
    data: {
      userId: user.id,
      runId: null,
      toolCallId: `pub_${crypto.randomUUID()}`,
      toolName: "crop_image",
      input: { image_url: "https://cdn/a.png" },
      microcreditsEstimated: 5000n,
      status: overrides.status ?? "PENDING",
      ...(overrides.microcreditsCharged !== undefined ? { microcreditsCharged: overrides.microcreditsCharged } : {}),
    },
  });
  if (overrides.status === undefined || overrides.status === "PENDING") {
    await reserveInvocation({ userId: user.id, runId: null, invocationId: invocation.id, microcredits: 5000 });
  }
  return { user, invocation };
}

async function ledgerAmount(idempotencyKey: string): Promise<bigint | undefined> {
  const row = await prisma.creditLedger.findUnique({ where: { idempotencyKey } });
  return row?.amount;
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

describe("tool-run task", () => {
  it("settles on success (release the estimate + charge the settled amount)", async () => {
    const { user, invocation } = await makeInvocation();
    triggerAndWait.mockResolvedValueOnce({
      ok: true,
      output: { ok: true, output: { image_url: "https://cdn/out.png" }, providerRunId: "prov_1", microcreditsCharged: 4000, durationMs: 500 },
    });

    await toolRunTask.run({ invocationId: invocation.id, input: { image_url: "https://cdn/a.png" } }, fakeParams());

    expect(triggerAndWait).toHaveBeenCalledWith(
      { invocationId: invocation.id, input: { image_url: "https://cdn/a.png" } },
      { idempotencyKey: invocation.id, idempotencyKeyTTL: "24h" },
    );
    expect(await ledgerAmount(`release:${invocation.id}`)).toBe(5000n);
    expect(await ledgerAmount(`charge:${invocation.id}`)).toBe(-4000n);

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.creditBalance).toBe(1_000_000n - 4000n); // estimate fully returned, only the real charge deducted
  });

  it("settles WITH the charge when a failure carries details.microcreditsCharged (provider billed before failing)", async () => {
    const { user, invocation } = await makeInvocation();
    triggerAndWait.mockResolvedValueOnce({
      ok: true,
      output: { ok: false, error: { code: "provider_error", message: "Could not parse the result", retryable: false, details: { microcreditsCharged: 3000, providerRunId: "prov_2" } } },
    });

    await toolRunTask.run({ invocationId: invocation.id, input: {} }, fakeParams());

    expect(await ledgerAmount(`release:${invocation.id}`)).toBe(5000n);
    expect(await ledgerAmount(`charge:${invocation.id}`)).toBe(-3000n);
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.creditBalance).toBe(1_000_000n - 3000n);
  });

  it("releases (no charge) on a plain failure with no settled amount", async () => {
    const { user, invocation } = await makeInvocation();
    triggerAndWait.mockResolvedValueOnce({
      ok: true,
      output: { ok: false, error: { code: "provider_error", message: "The media job failed.", retryable: false } },
    });

    await toolRunTask.run({ invocationId: invocation.id, input: {} }, fakeParams());

    expect(await ledgerAmount(`release:${invocation.id}`)).toBe(5000n);
    expect(await ledgerAmount(`charge:${invocation.id}`)).toBeUndefined();
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.creditBalance).toBe(1_000_000n); // fully refunded
  });

  it("releases and marks the invocation FAILED when the child task itself crashed (layer-1 failure)", async () => {
    const { user, invocation } = await makeInvocation();
    triggerAndWait.mockResolvedValueOnce({ ok: false, error: "boom" });

    await toolRunTask.run({ invocationId: invocation.id, input: {} }, fakeParams());

    expect(await ledgerAmount(`release:${invocation.id}`)).toBe(5000n);
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.creditBalance).toBe(1_000_000n);
  });

  it("no double settlement on replay of an already-terminal invocation", async () => {
    const { user, invocation } = await makeInvocation({ status: "COMPLETED", microcreditsCharged: 4000n });
    // Simulate an earlier attempt having already settled this invocation.
    await settleInvocation({ userId: user.id, runId: null, invocationId: invocation.id, estimated: 5000, charged: 4000 });
    const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditBalance;

    await toolRunTask.run({ invocationId: invocation.id, input: {} }, fakeParams());

    expect(triggerAndWait).not.toHaveBeenCalled();
    const releaseCount = await prisma.creditLedger.count({ where: { idempotencyKey: `release:${invocation.id}` } });
    const chargeCount = await prisma.creditLedger.count({ where: { idempotencyKey: `charge:${invocation.id}` } });
    expect(releaseCount).toBe(1);
    expect(chargeCount).toBe(1);
    const balanceAfter = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditBalance;
    expect(balanceAfter).toBe(balanceBefore);
  });
});
