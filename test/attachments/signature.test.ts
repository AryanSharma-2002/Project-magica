import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signParams, verifySignature } from "@/lib/transloadit/signature";

describe("Transloadit signParams (outbound, HMAC-SHA384)", () => {
  it("matches an independently computed HMAC-SHA384 hex digest, prefixed sha384:", () => {
    const paramsString = JSON.stringify({ auth: { key: "the-key", expires: "2026-01-01T00:00:00.000Z", nonce: "abc-123" }, steps: { ":original": { robot: "/upload/handle" } } });
    const secret = "the-secret";

    const expectedHex = createHmac("sha384", secret).update(paramsString, "utf8").digest("hex");
    const actual = signParams(paramsString, secret);

    expect(actual).toBe(`sha384:${expectedHex}`);
  });

  it("produces a different signature for a different secret or a different params string (sanity)", () => {
    const paramsString = JSON.stringify({ a: 1 });
    const s1 = signParams(paramsString, "secret-a");
    const s2 = signParams(paramsString, "secret-b");
    const s3 = signParams(JSON.stringify({ a: 2 }), "secret-a");
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(s3);
  });
});

describe("Transloadit verifySignature (inbound webhook)", () => {
  const secret = "webhook-secret";
  const rawBody = JSON.stringify({ ok: "ASSEMBLY_COMPLETED", assembly_id: "asm_1" });

  it("accepts a valid signature with no algorithm prefix, defaulting to sha1 (per Transloadit's documented backwards-compatibility requirement)", () => {
    const expectedHex = createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
    expect(verifySignature(rawBody, expectedHex, secret)).toBe(true);
  });

  it("accepts a valid signature with an explicit algorithm prefix", () => {
    const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    expect(verifySignature(rawBody, `sha256:${expectedHex}`, secret)).toBe(true);
  });

  it("rejects a tampered body (signature computed over a different payload)", () => {
    const signatureForOtherBody = createHmac("sha1", secret).update(JSON.stringify({ ok: "ASSEMBLY_COMPLETED", assembly_id: "asm_evil" }), "utf8").digest("hex");
    expect(verifySignature(rawBody, signatureForOtherBody, secret)).toBe(false);
  });

  it("rejects a tampered/incorrect signature value outright", () => {
    expect(verifySignature(rawBody, "0000000000000000000000000000000000000000", secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const wrongSecretSig = createHmac("sha1", "not-the-secret").update(rawBody, "utf8").digest("hex");
    expect(verifySignature(rawBody, wrongSecretSig, secret)).toBe(false);
  });

  it("rejects a missing/empty signature header", () => {
    expect(verifySignature(rawBody, null, secret)).toBe(false);
    expect(verifySignature(rawBody, "", secret)).toBe(false);
    expect(verifySignature(rawBody, "   ", secret)).toBe(false);
  });

  it("rejects an unknown algorithm prefix", () => {
    expect(verifySignature(rawBody, "md5:deadbeef", secret)).toBe(false);
  });
});
