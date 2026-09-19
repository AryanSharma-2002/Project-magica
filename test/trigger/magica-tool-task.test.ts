import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { truncateAll, createTestRun, createTestToolInvocation } from "../db-helpers";
import type { MagicaToolPayload, MagicaToolResult } from "@/trigger/magica-tool.task";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
  metadata: { set: vi.fn(), flush: vi.fn(), parent: { set: vi.fn() } },
}));

const { magicaToolTask: magicaToolTaskExport } = await import("@/trigger/magica-tool.task");

/**
 * `task()` is mocked to return its options object as-is (see the vi.mock above), so the real
 * value has a callable `.run`. The SDK's public `Task<...>` type doesn't expose `.run` though
 * (that's an implementation detail of the options object `task()` normally consumes) - this
 * local type describes what the mock actually hands back.
 */
type FakeTaskParams = { ctx: { run: { id: string } }; signal: AbortSignal };
const magicaToolTask = magicaToolTaskExport as unknown as { run: (payload: MagicaToolPayload, params: FakeTaskParams) => Promise<MagicaToolResult> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeParams(triggerRunId = "trun_1"): FakeTaskParams {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

describe("magica-tool child task replay/idempotency", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.unstubAllGlobals();
  });

  it("returns the stored result for an already-COMPLETED invocation without any HTTP call", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "COMPLETED", output: { image_url: "https://cdn/a.png" }, providerRunId: "prov_done", microcreditsCharged: 5000n, durationMs: 1200 },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result).toEqual({ ok: true, output: { image_url: "https://cdn/a.png" }, providerRunId: "prov_done", microcreditsCharged: 5000, durationMs: 1200 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the stored SafeError for an already-FAILED invocation without any HTTP call", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    const safeError = { code: "provider_error" as const, message: "The media job failed.", retryable: false };
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { status: "FAILED", error: safeError } });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result).toEqual({ ok: false, error: safeError });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the stored result for an already-CANCELLED invocation without any HTTP call", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { status: "CANCELLED" } });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an invocation with a providerRunId already set skips the POST and polls directly", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: {
        status: "RUNNING",
        providerRunId: "existing_run_1",
        input: { image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "existing_run_1", status: "COMPLETED", output: { image_url: ["https://cdn/done.png"] }, error: null, userMessage: null, creditUsed: 5000, createdAt: "x" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result).toMatchObject({ ok: true, output: { image_url: "https://cdn/done.png" }, providerRunId: "existing_run_1" });
    // Every call must be a GET to the runs endpoint - never a POST to start a new job.
    for (const call of fetchMock.mock.calls) {
      const url = call[0] as string;
      const init = call[1] as RequestInit;
      expect(url).toContain("/v1/nodes/runs/existing_run_1");
      expect(init.method).toBe("GET");
    }

    const updated = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.providerRunId).toBe("existing_run_1");
  });

  it("a fresh invocation (no providerRunId) POSTs once, persists the providerRunId, then polls", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: { input: { image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 } },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "fresh_run_1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "fresh_run_1", status: "COMPLETED", output: { image_url: ["https://cdn/fresh.png"] }, error: null, userMessage: null, creditUsed: 5000, createdAt: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result).toMatchObject({ ok: true, providerRunId: "fresh_run_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[0] as string)).toContain("/v1/nodes/crop_image/run");
  });
});
