import { HTTP_STATUS_BY_CODE, type ErrorCode, type SafeError } from "@agent-chat/contracts";
import { z } from "zod";

/**
 * The only error type that crosses module boundaries. Anything else becomes `internal`
 * with a generic message so provider details never leak to users or persisted rows.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;
  /** Original error for logs only; never serialized. */
  readonly cause: unknown;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean | undefined; details?: Record<string, unknown> | undefined; cause?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.status = HTTP_STATUS_BY_CODE[code];
    this.cause = opts.cause;
  }

  toSafe(): SafeError {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }

  static from(err: unknown, fallback: { code?: ErrorCode; message?: string } = {}): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof z.ZodError) {
      return new AppError("validation_error", "Request failed validation", {
        details: { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        cause: err,
      });
    }
    if (isAbortError(err)) return new AppError("cancelled", "The operation was cancelled", { cause: err });
    return new AppError(fallback.code ?? "internal", fallback.message ?? "Something went wrong. Please try again.", { retryable: true, cause: err });
  }
}

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

export const errors = {
  notFound: (what = "Resource") => new AppError("not_found", `${what} not found`),
  unauthorized: () => new AppError("unauthorized", "Authentication required"),
  forbidden: () => new AppError("forbidden", "You do not have access to this resource"),
  validation: (message: string, details?: Record<string, unknown>) => new AppError("validation_error", message, { details }),
  runActive: () => new AppError("run_active", "This chat already has a run in progress. Stop it or wait for it to finish."),
  insufficientCredits: (required: number, available: number) =>
    new AppError("insufficient_credits", "You do not have enough credits for this action.", { details: { required, available } }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError("rate_limited", "Too many requests. Please slow down.", { retryable: true, details: { retryAfterSeconds } }),
};
