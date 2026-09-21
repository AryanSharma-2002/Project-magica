import { describe, expect, it, vi } from "vitest";
import { assertDeliverableUrl, type DnsLookupFn } from "@/lib/webhooks/url-guard";
import { AppError } from "@/lib/errors";

async function expectRejected(url: string, opts?: Parameters<typeof assertDeliverableUrl>[1]): Promise<void> {
  await expect(assertDeliverableUrl(url, opts)).rejects.toBeInstanceOf(AppError);
  await expect(assertDeliverableUrl(url, opts)).rejects.toMatchObject({ code: "validation_error" });
}

describe("assertDeliverableUrl", () => {
  it("accepts an https URL to a public hostname resolving to a public IP", async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(assertDeliverableUrl("https://example.com/hook", { mode: "production", lookup })).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("rejects a plain http URL in production", async () => {
    await expectRejected("http://example.com/hook", { mode: "production" });
  });

  it("rejects localhost", async () => {
    await expectRejected("https://localhost/hook", { mode: "production" });
  });

  it("rejects 127.0.0.1 (loopback)", async () => {
    await expectRejected("https://127.0.0.1/hook", { mode: "production" });
  });

  it("rejects a 10.x private address", async () => {
    await expectRejected("https://10.1.2.3/hook", { mode: "production" });
  });

  it("rejects a 169.254.x link-local / metadata address", async () => {
    await expectRejected("https://169.254.169.254/hook", { mode: "production" });
  });

  it("rejects [::1] (IPv6 loopback)", async () => {
    await expectRejected("https://[::1]/hook", { mode: "production" });
  });

  it("rejects a hostname that resolves to a private IP", async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    await expectRejected("https://evil.example.com/hook", { mode: "production", lookup });
  });

  it("rejects a hostname where DNS resolution fails", async () => {
    const lookup: DnsLookupFn = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    await expectRejected("https://nowhere.example.com/hook", { mode: "production", lookup });
  });

  it("rejects *.internal and *.local literal hostnames even without DNS", async () => {
    await expectRejected("https://box.internal/hook", { mode: "production" });
    await expectRejected("https://box.local/hook", { mode: "production" });
  });

  it("development mode allows http://localhost (no DNS lookup needed)", async () => {
    const lookup: DnsLookupFn = vi.fn();
    await expect(assertDeliverableUrl("http://localhost:3000/hook", { mode: "development", lookup })).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("development mode allows https://127.0.0.1 too", async () => {
    await expect(assertDeliverableUrl("https://127.0.0.1:3000/hook", { mode: "development" })).resolves.toBeUndefined();
  });

  it("development mode still rejects a non-loopback private address (the exception is loopback-only)", async () => {
    await expectRejected("http://10.0.0.5/hook", { mode: "development" });
  });

  it("development mode still rejects the cloud metadata address", async () => {
    await expectRejected("http://169.254.169.254/hook", { mode: "development" });
  });

  it("rejects a malformed URL", async () => {
    await expectRejected("not a url", { mode: "production" });
  });
});
