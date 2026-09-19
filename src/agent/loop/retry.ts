import type { ErrorCode } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";

/** Total LLM call attempts per turn: 1 initial + 2 retries, backoff 1s -> 2s between them. */
export const MAX_LLM_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MS = 250;

export type Sleep = (ms: number) => Promise<void>;
export type RandomFn = () => number;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const defaultRandom: RandomFn = () => Math.random();

export function isRetryableProviderError(err: AppError): boolean {
  return err.code === "provider_rate_limited" || err.code === "provider_unavailable" || err.code === "empty_response";
}

/** Backoff before attempt number `nextAttempt` (2 -> 1s, 3 -> 2s). */
export function backoffMs(nextAttempt: number, random: RandomFn): number {
  const exponent = Math.max(0, nextAttempt - 2);
  return BASE_DELAY_MS * Math.pow(2, exponent) + Math.floor(random() * JITTER_MS);
}

/**
 * Terminal error code once retries are exhausted. Perpetual rate-limiting is reported to the user
 * as the service being unavailable (there is nothing they can do about an ongoing 429), not as a
 * literal "you are being rate limited" that implies retrying will help.
 */
export function terminalCodeAfterExhaustion(code: ErrorCode): ErrorCode {
  return code === "provider_rate_limited" ? "provider_unavailable" : code;
}
