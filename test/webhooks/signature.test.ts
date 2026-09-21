import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "@/lib/webhooks/signature";

describe("signWebhookPayload / verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const rawBody = JSON.stringify({ id: "evt_1", type: "agent.completed", createdAt: "2026-09-21T00:00:00.000Z", data: { runId: "run_1", chatId: "chat_1", status: "completed" } });

  it("round trips: a signature produced by signWebhookPayload verifies against the same secret + body", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, rawBody, header, { nowSeconds: now })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now);
    const tamperedBody = rawBody.replace("completed", "failed");
    expect(verifyWebhookSignature(secret, tamperedBody, header, { nowSeconds: now })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now);
    expect(verifyWebhookSignature("whsec_wrong_secret", rawBody, header, { nowSeconds: now })).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window (default 300s)", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now - 301);
    expect(verifyWebhookSignature(secret, rawBody, header, { nowSeconds: now })).toBe(false);
  });

  it("accepts a timestamp exactly at the edge of the tolerance window", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now - 300);
    expect(verifyWebhookSignature(secret, rawBody, header, { nowSeconds: now })).toBe(true);
  });

  it("respects a custom toleranceSeconds", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(secret, rawBody, now - 10);
    expect(verifyWebhookSignature(secret, rawBody, header, { nowSeconds: now, toleranceSeconds: 5 })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, header, { nowSeconds: now, toleranceSeconds: 15 })).toBe(true);
  });

  it("rejects malformed headers: missing v1, missing t, garbage, empty, null", () => {
    const now = 1_700_000_000;
    expect(verifyWebhookSignature(secret, rawBody, `t=${now}`, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, "v1=deadbeef", { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, "not-a-signature-header", { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, "", { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, null, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, undefined, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, rawBody, `t=not-a-number,v1=deadbeef`, { nowSeconds: now })).toBe(false);
  });

  it("rejects a v1 of the wrong length (not just wrong value) without throwing", () => {
    const now = 1_700_000_000;
    expect(verifyWebhookSignature(secret, rawBody, `t=${now},v1=short`, { nowSeconds: now })).toBe(false);
  });
});
