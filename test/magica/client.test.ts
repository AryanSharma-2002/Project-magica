import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { estimateCredits, getRun, pollRun, runNode } from "@/agent/providers/magica/client";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const MAGICA_KEY = "magica-test"; // set in test/setup.ts

describe("magica client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runNode returns the runId from a 202, and getRun/pollRun follow QUEUED -> RUNNING -> COMPLETED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: "run_1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "run_1", nodeType: "crop_image", status: "QUEUED", output: null, error: null, userMessage: null, creditUsed: null, createdAt: "2026-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "run_1", nodeType: "crop_image", status: "RUNNING", output: null, error: null, userMessage: null, creditUsed: null, createdAt: "2026-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "run_1", nodeType: "crop_image", status: "COMPLETED", output: { image_url: ["https://cdn.example.com/a.png"] }, error: null, userMessage: null, creditUsed: 12_000, createdAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    const { runId } = await runNode({ nodeType: "crop_image", input: { image_url: "https://x/y.png" } });
    expect(runId).toBe("run_1");

    // Never send the key anywhere but the Authorization header.
    const [, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((postInit.headers as Record<string, string>).authorization).toBe(`Bearer ${MAGICA_KEY}`);
    expect(postInit.body).not.toContain(MAGICA_KEY);

    vi.useFakeTimers();
    const pollPromise = pollRun(runId, { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const run = await pollPromise;

    expect(run.status).toBe("COMPLETED");
    expect(run.creditUsed).toBe(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("maps a FAILED run to provider_error using the run's userMessage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { id: "run_2", nodeType: "crop_image", status: "FAILED", output: null, error: { detail: "x" }, userMessage: "The source image could not be read.", creditUsed: null, createdAt: "2026-01-01T00:00:00.000Z" }),
      ),
    );
    await expect(pollRun("run_2", {})).rejects.toMatchObject({ code: "provider_error", message: "The source image could not be read.", retryable: false });
  });

  it("maps FAILED without a userMessage to a generic safe message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { id: "run_3", status: "FAILED", output: null, error: {}, userMessage: null, creditUsed: null, createdAt: "x" })));
    await expect(pollRun("run_3", {})).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });

  it("401 -> provider_error, not retryable, with the fixed safe message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid key" })));
    const err = await runNode({ nodeType: "crop_image", input: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("provider_error");
    expect((err as AppError).retryable).toBe(false);
    expect((err as AppError).message).toBe("Media provider rejected the request");
  });

  it("429 -> provider_rate_limited, retryable, honoring Retry-After (seconds)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { message: "slow down" }, { "retry-after": "7" })));
    const err = await getRun("run_4").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("provider_rate_limited");
    expect((err as AppError).retryable).toBe(true);
    expect((err as AppError).details).toMatchObject({ retryAfterSeconds: 7 });
  });

  it("429 honors an HTTP-date Retry-After", async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {}, { "retry-after": future })));
    const err = (await getRun("run_5").catch((e: unknown) => e)) as AppError;
    expect(err.details?.retryAfterSeconds).toBeGreaterThan(20);
    expect(err.details?.retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it("retries a 5xx POST once and succeeds on the second attempt (single successful POST, no double submit)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: "overloaded" }))
      .mockResolvedValueOnce(jsonResponse(202, { runId: "run_6" }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const runPromise = runNode({ nodeType: "crop_image", input: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    const { runId } = await runPromise;

    expect(runId).toBe("run_6");
    // Exactly one retry, exactly one successful POST - never double-submitted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pollRun times out after timeoutMs while the run stays non-terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => jsonResponse(200, { id: "run_7", status: "QUEUED", output: null, error: null, userMessage: null, creditUsed: null, createdAt: "x" })),
    );
    vi.useFakeTimers();
    const p = pollRun("run_7", { timeoutMs: 2_500 });
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("an already-aborted signal makes pollRun reject with cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pollRun("run_8", { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("an AbortError thrown by fetch itself maps to cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    await expect(getRun("run_9")).rejects.toMatchObject({ code: "cancelled" });
  });

  it("estimateCredits returns microcredits in request order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { estimates: [{ microcredits: 1000 }, { microcredits: 2000 }] })));
    const result = await estimateCredits([{ type: "crop_image" }, { type: "merge_videos" }]);
    expect(result).toEqual([1000, 2000]);
  });

  it("never leaks the API key in a thrown error, even when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "nope" })));
    const err = (await runNode({ nodeType: "crop_image", input: {} }).catch((e: unknown) => e)) as AppError;
    const serialized = JSON.stringify(err.toSafe());
    expect(serialized).not.toContain(MAGICA_KEY);
    expect(err.message).not.toContain(MAGICA_KEY);
  });
});
