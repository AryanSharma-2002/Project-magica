import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { truncateAll, createTestRun, createTestToolInvocation } from "../db-helpers";
import type { MagicaToolPayload, MagicaToolResult } from "@/trigger/magica-tool.task";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
  metadata: { set: vi.fn(), flush: vi.fn(), parent: { set: vi.fn() } },
}));

const { magicaToolTask: magicaToolTaskExport } = await import("@/trigger/magica-tool.task");

type FakeTaskParams = { ctx: { run: { id: string } }; signal: AbortSignal };
const magicaToolTask = magicaToolTaskExport as unknown as { run: (payload: MagicaToolPayload, params: FakeTaskParams) => Promise<MagicaToolResult> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const input = { image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 };

/**
 * Live finding 2026-09-21: a Magica run COMPLETED (and billed 7,644 µc) but its output did not
 * match our normalizer, so the invocation failed with `microcreditsCharged: 0` and the parent
 * released the reservation - the user was never charged for a job the provider billed us for.
 */
describe("magica-tool child task: a COMPLETED provider run with unparseable output", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.unstubAllGlobals();
  });

  it("fails NON-retryably and persists the provider's settled charge and run id on the row", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "billed_run_1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "billed_run_1", status: "COMPLETED", output: { unexpected: "shape" }, error: null, userMessage: null, creditUsed: 5000, createdAt: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id, input }, { ctx: { run: { id: "trun_billed" } }, signal: new AbortController().signal });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("provider_error");
    expect(result.error.retryable).toBe(false);
    expect(result.error.details).toMatchObject({ providerRunId: "billed_run_1", microcreditsCharged: 5000 });

    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.microcreditsCharged).toBe(5000n);
    expect(row.providerRunId).toBe("billed_run_1");
  });

  it("a provider-side FAILED run still records no charge", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "failed_run_1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "failed_run_1", status: "FAILED", output: null, error: "boom", userMessage: "The media job failed.", creditUsed: 0, createdAt: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id, input }, { ctx: { run: { id: "trun_failed" } }, signal: new AbortController().signal });

    expect(result.ok).toBe(false);
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.microcreditsCharged).toBe(0n);
  });
});
