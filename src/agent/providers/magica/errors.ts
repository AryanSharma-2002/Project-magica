import { AppError } from "@/lib/errors";
import type { MagicaRun } from "./client";

/**
 * Maps Magica HTTP/run failures to AppError per ARCHITECTURE.md §5.3.
 * Never includes the Authorization header or MAGICA_API_KEY in any message/detail.
 */

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return undefined;
}

/** Best-effort, short, safe excerpt of a provider-supplied message (never our request payload). */
function safeProviderMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0 && m.length <= 300) return m;
  }
  return undefined;
}

export async function mapMagicaHttpError(res: Response): Promise<AppError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const providerMessage = safeProviderMessage(body);

  switch (res.status) {
    case 400:
      return new AppError("validation_error", providerMessage ?? "The media provider rejected the request input.", {
        details: { status: 400 },
      });
    case 401:
      return new AppError("provider_error", "Media provider rejected the request", {
        retryable: false,
        details: { status: 401 },
      });
    case 403:
      return new AppError("provider_error", "Media provider rejected the request", {
        retryable: false,
        details: { status: 403, reason: "provider_credits" },
      });
    case 404:
      return new AppError("provider_error", "Media provider rejected the request", {
        retryable: false,
        details: { status: 404, reason: "unknown_node" },
      });
    case 410:
      return new AppError("provider_error", "Media provider rejected the request", {
        retryable: false,
        details: { status: 410, reason: "retired" },
      });
    case 429: {
      const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("retry-after"));
      return new AppError("provider_rate_limited", "Media provider is rate limiting requests", {
        retryable: true,
        details: retryAfterSeconds !== undefined ? { retryAfterSeconds } : {},
      });
    }
    default:
      if (res.status >= 500) {
        return new AppError("provider_unavailable", "Media provider is temporarily unavailable", {
          retryable: true,
          details: { status: res.status },
        });
      }
      return new AppError("provider_error", "Media provider rejected the request", {
        retryable: false,
        details: { status: res.status },
      });
  }
}

/** `run.status === "FAILED"` -> provider_error with the run's userMessage (safe fallback). */
export function mapMagicaRunFailure(run: MagicaRun): AppError {
  return new AppError("provider_error", run.userMessage ?? "The media job failed.", {
    retryable: false,
    details: { providerRunId: run.id },
  });
}

export function magicaCancelled(): AppError {
  return new AppError("cancelled", "The operation was cancelled");
}

export function magicaTimeout(): AppError {
  return new AppError("timeout", "The media job timed out", { retryable: false });
}

export function magicaNetworkError(cause: unknown): AppError {
  return new AppError("provider_unavailable", "Could not reach the media provider", { retryable: true, cause });
}
