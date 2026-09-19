import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Transloadit Signature Authentication (verified against the current docs at
 * https://transloadit.com/docs/topics/signature-authentication/ and the reference
 * implementation in @transloadit/utils, September 2026 - see the final report for exactly what
 * was checked). Two distinct algorithms are in play:
 *
 *   - Outbound (this file's `signParams`): signing OUR OWN request params when creating an
 *     Assembly. HMAC-SHA384, hex-encoded, prefixed with the algorithm name: "sha384:<hex>".
 *   - Inbound (`verifySignature`, used by the notify webhook handler): verifying a signature
 *     Transloadit sends US. Per the docs, this "must use the sha1 algorithm due to backwards
 *     compatibility issues" and is computed over the exact raw `transloadit` field STRING, not a
 *     reserialized copy of the parsed JSON. The reference implementation defaults to "sha1" when
 *     the header has no "<algo>:" prefix, and to whatever prefix is present otherwise - mirrored
 *     here for robustness even though Transloadit's own notify calls are documented as SHA1-only.
 */

export type SignatureAlgorithm = "sha1" | "sha256" | "sha384" | "sha512";

const KNOWN_ALGORITHMS: ReadonlySet<string> = new Set(["sha1", "sha256", "sha384", "sha512"]);

/** Signs a Transloadit `params` JSON string for an outbound API request (e.g. creating an Assembly). */
export function signParams(paramsString: string, authSecret: string, algorithm: SignatureAlgorithm = "sha384"): string {
  const hex = createHmac(algorithm, authSecret).update(paramsString, "utf8").digest("hex");
  return `${algorithm}:${hex}`;
}

/**
 * Verifies an inbound Transloadit webhook signature. `rawBody` MUST be the exact string of the
 * `transloadit` form field (not a re-serialization of its parsed JSON). Constant-time comparison
 * of equal-length hex strings.
 */
export function verifySignature(rawBody: string, signatureHeader: string | null | undefined, authSecret: string): boolean {
  if (!signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  if (!trimmed) return false;

  const sep = trimmed.indexOf(":");
  const algorithm = (sep === -1 ? "sha1" : trimmed.slice(0, sep).toLowerCase()) as SignatureAlgorithm;
  const signature = sep === -1 ? trimmed : trimmed.slice(sep + 1);
  if (!KNOWN_ALGORITHMS.has(algorithm) || signature.length === 0) return false;

  const expectedHex = createHmac(algorithm, authSecret).update(rawBody, "utf8").digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
