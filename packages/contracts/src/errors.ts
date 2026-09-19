import { z } from "zod";

/** Stable, user-safe error codes. HTTP status is derived from the code on the server. */
export const ErrorCode = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "run_active",
  "rate_limited",
  "insufficient_credits",
  "payload_too_large",
  "unsupported_media_type",
  "provider_unavailable",
  "provider_error",
  "provider_rate_limited",
  "malformed_tool_call",
  "empty_response",
  "timeout",
  "cancelled",
  "max_turns_exceeded",
  "waitpoint_expired",
  "stale_run_recovered",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Persisted / streamed error shape. Never contains provider secrets or raw stack traces. */
export const SafeError = z.object({
  code: ErrorCode,
  message: z.string().max(1000),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type SafeError = z.infer<typeof SafeError>;

/** HTTP error envelope returned by every route. */
export const ApiErrorEnvelope = z.object({
  error: SafeError.extend({ traceId: z.string() }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelope>;

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  run_active: 409,
  rate_limited: 429,
  insufficient_credits: 402,
  payload_too_large: 413,
  unsupported_media_type: 415,
  provider_unavailable: 503,
  provider_error: 502,
  provider_rate_limited: 429,
  malformed_tool_call: 502,
  empty_response: 502,
  timeout: 504,
  cancelled: 409,
  max_turns_exceeded: 422,
  waitpoint_expired: 410,
  stale_run_recovered: 409,
  internal: 500,
};
