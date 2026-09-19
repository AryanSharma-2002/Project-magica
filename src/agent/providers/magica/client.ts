import { getEnv } from "@/lib/env";
import { AppError, isAbortError } from "@/lib/errors";
import { magicaCancelled, magicaNetworkError, magicaTimeout, mapMagicaHttpError, mapMagicaRunFailure } from "./errors";

/**
 * Thin HTTP client for the Magica inference API (ARCHITECTURE.md §5.3).
 * The API key is read from env at call time and only ever placed in the outgoing
 * Authorization header - never logged, returned, or embedded in thrown errors.
 */

export type MagicaRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";

export type MagicaRun = {
  id: string;
  nodeType: string;
  subModelId: string | null;
  status: MagicaRunStatus;
  input: unknown;
  output: unknown;
  error: unknown;
  userMessage: string | null;
  creditUsed: number | null;
  source: unknown;
  createdAt: string;
};

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${getEnv().MAGICA_API_KEY}`, "content-type": "application/json" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(magicaCancelled());
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(magicaCancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function magicaFetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${getEnv().MAGICA_BASE_URL}${path}`, signal ? { ...init, signal } : init);
  } catch (err) {
    if (isAbortError(err)) throw magicaCancelled();
    throw magicaNetworkError(err);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000);
}

export type RunNodeArgs = {
  nodeType: string;
  input: Record<string, unknown>;
  subModelId?: string;
  signal?: AbortSignal;
};

/**
 * POST /v1/nodes/{nodeType}/run. Bounded retries (3 attempts total), only while no runId has
 * been obtained yet and the failure is retryable - never double-submits a job.
 */
export async function runNode(args: RunNodeArgs): Promise<{ runId: string }> {
  const body = JSON.stringify({ input: args.input, ...(args.subModelId ? { subModelId: args.subModelId } : {}) });
  let lastError: AppError | undefined;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLast = attempt === maxAttempts - 1;
    let res: Response;
    try {
      res = await magicaFetch(`/v1/nodes/${args.nodeType}/run`, { method: "POST", headers: authHeaders(), body }, args.signal);
    } catch (err) {
      const app = err instanceof AppError ? err : magicaNetworkError(err);
      if (app.code === "cancelled" || !app.retryable || isLast) throw app;
      lastError = app;
      await sleep(backoffMs(attempt), args.signal);
      continue;
    }
    if (res.status === 202) {
      const json = (await res.json()) as { runId: string };
      return { runId: json.runId };
    }
    const app = await mapMagicaHttpError(res);
    if (!app.retryable || isLast) throw app;
    lastError = app;
    await sleep(backoffMs(attempt), args.signal);
  }
  throw lastError ?? magicaNetworkError(new Error("runNode exhausted retries"));
}

/** GET /v1/nodes/runs/{runId} */
export async function getRun(runId: string, signal?: AbortSignal): Promise<MagicaRun> {
  const res = await magicaFetch(`/v1/nodes/runs/${runId}`, { method: "GET", headers: authHeaders() }, signal);
  if (!res.ok) throw await mapMagicaHttpError(res);
  return (await res.json()) as MagicaRun;
}

export type PollOptions = {
  signal?: AbortSignal;
  /** default 10 minutes */
  timeoutMs?: number;
  onProgress?: (run: MagicaRun) => void;
};

/** Polls until COMPLETED/FAILED/CANCELED/timeout. Backoff 1s -> 5s (cap). Cancellation-aware. */
export async function pollRun(runId: string, opts: PollOptions = {}): Promise<MagicaRun> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const start = Date.now();
  let delay = 1_000;
  for (;;) {
    if (opts.signal?.aborted) throw magicaCancelled();
    const run = await getRun(runId, opts.signal);
    opts.onProgress?.(run);
    if (run.status === "COMPLETED") return run;
    if (run.status === "FAILED") throw mapMagicaRunFailure(run);
    if (run.status === "CANCELED") throw magicaCancelled();
    if (Date.now() - start >= timeoutMs) throw magicaTimeout();
    await sleep(delay, opts.signal);
    delay = Math.min(delay * 2, 5_000);
  }
}

export type EstimateNode = { type: string; subModelId?: string; data?: Record<string, unknown> };

/** POST /v1/nodes/estimate-credits -> microcredits per requested node, in order. */
export async function estimateCredits(nodes: EstimateNode[], signal?: AbortSignal): Promise<number[]> {
  const res = await magicaFetch(
    "/v1/nodes/estimate-credits",
    { method: "POST", headers: authHeaders(), body: JSON.stringify({ nodes }) },
    signal,
  );
  if (!res.ok) throw await mapMagicaHttpError(res);
  const json = (await res.json()) as { estimates: Array<{ microcredits: number }> };
  return json.estimates.map((e) => e.microcredits);
}
