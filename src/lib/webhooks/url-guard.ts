import dns from "node:dns";
import { isIP } from "node:net";
import { errors } from "@/lib/errors";
import { getEnv, type Env } from "@/lib/env";

/**
 * SSRF guard for webhook endpoint URLs (ARCHITECTURE.md §9: "must be https and must not resolve
 * to loopback/private ranges (guard disabled in development so a local receiver works)").
 *
 * This implementation is deliberately narrower than "disabled": in development it allows `http:`
 * AND loopback hosts (localhost / 127.0.0.0/8 / ::1) so a developer can point an endpoint at a
 * local receiver, but it still blocks other private/link-local/metadata ranges even in
 * development - those aren't needed for "a local receiver works" and are exactly the addresses
 * this guard exists to keep the server from being tricked into hitting (e.g. the cloud metadata
 * endpoint at 169.254.169.254). This is a deviation from the literal word "disabled" in
 * ARCHITECTURE.md; see the final report.
 *
 * Both the environment mode and the DNS resolver are injectable so tests never depend on the
 * real network or on mutating global env state.
 */

export type DnsLookupFn = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

export type UrlGuardOptions = {
  mode?: Env["NODE_ENV"];
  lookup?: DnsLookupFn;
};

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    n = (n << 8) | value;
  }
  return n >>> 0;
}

function inV4Range(ip: number, base: string, maskBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/** 127/8 (loopback), 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local, incl. cloud metadata), 0.0.0.0. */
function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  if (n === 0) return true; // 0.0.0.0
  return inV4Range(n, "127.0.0.0", 8) || inV4Range(n, "10.0.0.0", 8) || inV4Range(n, "172.16.0.0", 12) || inV4Range(n, "192.168.0.0", 16) || inV4Range(n, "169.254.0.0", 16);
}

function isLoopbackV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && inV4Range(n, "127.0.0.0", 8);
}

/** ::1 (loopback), :: (unspecified), fe80::/10 (link-local), fc00::/7 (unique-local), and IPv4-mapped addresses. */
function isBlockedV6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase();
  if (address === "::1" || address === "::") return true;
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4Mapped?.[1]) return isBlockedV4(v4Mapped[1]);
  const firstHextet = address.split(":")[0] ?? "";
  if (["fe8", "fe9", "fea", "feb"].some((p) => firstHextet.startsWith(p))) return true; // fe80::/10
  if (firstHextet.startsWith("fc") || firstHextet.startsWith("fd")) return true; // fc00::/7
  return false;
}

function isLoopbackV6(rawAddress: string): boolean {
  return rawAddress.toLowerCase() === "::1";
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostnameLiteral(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal");
}

async function defaultLookup(hostname: string, options: { all: true }): Promise<Array<{ address: string; family: number }>> {
  return dns.promises.lookup(hostname, options);
}

/** Throws `errors.validation(...)` if the URL is not safe to deliver a webhook to. */
export async function assertDeliverableUrl(url: string, opts: UrlGuardOptions = {}): Promise<void> {
  const mode = opts.mode ?? getEnv().NODE_ENV;
  const lookup = opts.lookup ?? defaultLookup;
  const allowLocalDev = mode === "development";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.validation("Webhook URL must be a valid absolute URL");
  }

  const host = stripBrackets(parsed.hostname).toLowerCase();
  const ipVersion = isIP(host); // 0 = not an IP literal, 4, or 6

  const isLoopbackLiteral = host === "localhost" || (ipVersion === 4 && isLoopbackV4(host)) || (ipVersion === 6 && isLoopbackV6(host));

  if (parsed.protocol !== "https:") {
    if (!(allowLocalDev && parsed.protocol === "http:" && isLoopbackLiteral)) {
      throw errors.validation("Webhook URL must use https" + (allowLocalDev ? " (http is only allowed to a loopback host in development)" : ""));
    }
  }

  // Dev exception: a loopback host (by whichever scheme) is allowed straight through - it is
  // exactly the case "so a local receiver works" describes, and nothing past this point applies.
  if (allowLocalDev && isLoopbackLiteral) return;

  if (isBlockedHostnameLiteral(host)) {
    throw errors.validation("Webhook URL host is not allowed");
  }

  if (ipVersion === 4) {
    if (isBlockedV4(host)) throw errors.validation("Webhook URL host is not allowed");
    return;
  }
  if (ipVersion === 6) {
    if (isBlockedV6(host)) throw errors.validation("Webhook URL host is not allowed");
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw errors.validation("Webhook URL host could not be resolved");
  }
  if (addresses.length === 0) {
    throw errors.validation("Webhook URL host could not be resolved");
  }
  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedV4(address)) throw errors.validation("Webhook URL resolves to a disallowed address");
    if (family === 6 && isBlockedV6(address)) throw errors.validation("Webhook URL resolves to a disallowed address");
  }
}
