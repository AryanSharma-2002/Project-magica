import { describe, expect, it, vi } from "vitest";
import { assertDeliverableUrl, expandIpv6, type DnsLookupFn } from "@/lib/webhooks/url-guard";

/**
 * Security review 2026-09-21: the WHATWG URL parser re-serializes IPv6 hostnames into compressed
 * hex groups, so `https://[::ffff:127.0.0.1]/` reaches the guard as `[::ffff:7f00:1]` and a
 * regex on the dotted spelling never fired. Classification is now numeric.
 */
const noDns: DnsLookupFn = vi.fn(async () => {
  throw new Error("DNS must not be consulted for IP literals");
});

async function rejected(url: string, lookup: DnsLookupFn = noDns): Promise<void> {
  await expect(assertDeliverableUrl(url, { mode: "production", lookup })).rejects.toMatchObject({ code: "validation_error" });
}

describe("expandIpv6", () => {
  it("expands compressed, full, and embedded-IPv4 spellings to 8 hextets", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::ffff:7f00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6("0:0:0:0:0:ffff:7f00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6("64:ff9b::a9fe:a9fe")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe]);
    expect(expandIpv6("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("returns null for garbage", () => {
    expect(expandIpv6("1:2:3")).toBeNull();
    expect(expandIpv6("::g")).toBeNull();
    expect(expandIpv6("1::2::3")).toBeNull();
  });
});

describe("assertDeliverableUrl: IPv6 forms of internal addresses", () => {
  it("rejects IPv4-mapped loopback however it is spelled", async () => {
    await rejected("https://[::ffff:7f00:1]/hook");
    await rejected("https://[::ffff:127.0.0.1]/hook");
    await rejected("https://[0:0:0:0:0:ffff:7f00:1]/hook");
  });

  it("rejects the IPv4-mapped cloud metadata address", async () => {
    await rejected("https://[::ffff:a9fe:a9fe]/latest/meta-data/");
  });

  it("rejects NAT64-embedded internal addresses", async () => {
    await rejected("https://[64:ff9b::7f00:1]/hook");
    await rejected("https://[64:ff9b::a9fe:a9fe]/hook");
  });

  it("rejects link-local, unique-local and unspecified IPv6", async () => {
    await rejected("https://[fe80::1]/hook");
    await rejected("https://[fd12:3456::1]/hook");
    await rejected("https://[::]/hook");
  });

  it("accepts a public IPv6 literal without DNS", async () => {
    await expect(assertDeliverableUrl("https://[2606:4700::1111]/hook", { mode: "production", lookup: noDns })).resolves.toBeUndefined();
  });

  it("rejects a hostname whose AAAA record is an IPv4-mapped private address", async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: "::ffff:10.0.0.7", family: 6 }]);
    await rejected("https://rebind.example.com/hook", lookup);
  });

  it("rejects the wider non-global IPv4 ranges (CGNAT, multicast, reserved, broadcast)", async () => {
    await rejected("https://100.64.1.1/hook");
    await rejected("https://224.0.0.1/hook");
    await rejected("https://240.0.0.1/hook");
    await rejected("https://255.255.255.255/hook");
    await rejected("https://198.18.0.1/hook");
  });

  it("development mode still allows only loopback, not an IPv4-mapped private address", async () => {
    await expect(assertDeliverableUrl("http://[::ffff:7f00:1]/hook", { mode: "development", lookup: noDns })).resolves.toBeUndefined();
    await expect(assertDeliverableUrl("https://[::ffff:a9fe:a9fe]/hook", { mode: "development", lookup: noDns })).rejects.toMatchObject({ code: "validation_error" });
  });
});
