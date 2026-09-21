import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signing (ARCHITECTURE.md §9 "Webhooks:" paragraph, docs/webhooks.mdx).
 * Header shape: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * `rawBody` must be the EXACT bytes sent on the wire (the receiver hashes what it received),
 * so callers must sign the same string they POST - never a re-serialized copy.
 */

const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(secret: string, rawBody: string, timestampSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

export type VerifyWebhookSignatureOptions = {
  /** Injectable "now" for deterministic tolerance tests. Defaults to the real clock. */
  nowSeconds?: number;
  /** Max allowed |now - t| in seconds. Default 300 (5 minutes), per the spec. */
  toleranceSeconds?: number;
};

/** Parses `t=...,v1=...` (order-insensitive, extra params ignored) into a lookup map. */
function parseHeader(header: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key.length > 0 && value.length > 0) parts.set(key, value);
  }
  return parts;
}

/**
 * Verifies an inbound-received copy of our own outbound signature (used by receivers, and by our
 * own tests/acceptance script). Constant-time comparison of the hex digest; malformed headers,
 * missing fields, and out-of-tolerance timestamps all fail closed (return false, never throw).
 */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | null | undefined, opts: VerifyWebhookSignatureOptions = {}): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (!trimmed) return false;

  const parts = parseHeader(trimmed);
  const tRaw = parts.get("t");
  const v1 = parts.get("v1");
  if (!tRaw || !v1) return false;

  const t = Number(tRaw);
  if (!Number.isFinite(t)) return false;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) return false;

  const expectedHex = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const actual = Buffer.from(v1, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
