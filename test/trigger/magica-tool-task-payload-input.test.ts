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

function fakeParams(): FakeTaskParams {
  return { ctx: { run: { id: "trun_payload" } }, signal: new AbortController().signal };
}

function providerRunCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/v1/nodes/merge_videos/run"));
}

/**
 * The parent loop persists `sanitizeInput(parsedInput)` on the ToolInvocation row for DISPLAY
 * (merge_videos truncates URL arrays to 20 entries + an "…(N more)" marker). Re-executing that
 * copy would hand the provider a bogus URL, so the durable adapter now ships the validated input
 * in the child payload and the child prefers it.
 */
describe("magica-tool child task: which input gets executed", () => {
  const fullUrls = Array.from({ length: 21 }, (_, i) => `https://cdn.example/clip-${i}.mp4`);
  const displayCopy = { video_urls: [...fullUrls.slice(0, 20), "…(1 more)"], transition: "none" };

  beforeEach(async () => {
    await truncateAll();
    vi.unstubAllGlobals();
  });

  it("executes the payload's validated input, not the display-sanitized DB copy", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "merge_videos" });
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { input: displayCopy } });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "merge_run_1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { id: "merge_run_1", status: "COMPLETED", output: { video_url: "https://cdn/merged.mp4" }, error: null, userMessage: null, creditUsed: 250_000, createdAt: "x" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id, input: { video_urls: fullUrls, transition: "none" } }, fakeParams());

    expect(result).toMatchObject({ ok: true, output: { video_url: "https://cdn/merged.mp4" }, providerRunId: "merge_run_1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/nodes/merge_videos/run");
    const body = JSON.parse(String(init.body)) as { input: { video_urls: string[] } };
    expect(body.input.video_urls).toEqual(fullUrls);
  });

  it("without a payload input, the lossy DB copy is rejected as malformed and never reaches the provider", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "merge_videos" });
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { input: displayCopy } });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_tool_call");
    expect(providerRunCalls(fetchMock)).toEqual([]);
    const updated = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(updated.status).toBe("FAILED");
  });

  it("falls back to the DB copy when the payload carries no input (older dispatches)", async () => {
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "merge_videos" });
    const twoUrls = fullUrls.slice(0, 2);
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { input: { video_urls: twoUrls, transition: "fade" } } });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "merge_run_2" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { id: "merge_run_2", status: "COMPLETED", output: { video_url: "https://cdn/merged-2.mp4" }, error: null, userMessage: null, creditUsed: 50_000, createdAt: "x" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await magicaToolTask.run({ invocationId: invocation.id }, fakeParams());

    expect(result).toMatchObject({ ok: true, providerRunId: "merge_run_2" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { input: { video_urls: string[]; transition: string } };
    expect(body.input).toEqual({ video_urls: twoUrls, transition: "fade" });
  });
});
