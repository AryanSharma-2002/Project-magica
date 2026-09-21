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

/**
 * Everything that is not global unicast: 0/8, 127/8 (loopback), 10/8, 172.16/12, 192.168/16,
 * 100.64/10 (CGNAT), 169.254/16 (link-local, incl. cloud metadata), 192.0.0/24, 198.18/15
 * (benchmarking), 224/4 (multicast), 240/4 (reserved, incl. 255.255.255.255).
 */
function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparsable: fail closed
  return (
    inV4Range(n, "0.0.0.0", 8) ||
    inV4Range(n, "127.0.0.0", 8) ||
    inV4Range(n, "10.0.0.0", 8) ||
    inV4Range(n, "172.16.0.0", 12) ||
    inV4Range(n, "192.168.0.0", 16) ||
    inV4Range(n, "100.64.0.0", 10) ||
    inV4Range(n, "169.254.0.0", 16) ||
    inV4Range(n, "192.0.0.0", 24) ||
    inV4Range(n, "198.18.0.0", 15) ||
    inV4Range(n, "224.0.0.0", 4) ||
    inV4Range(n, "240.0.0.0", 4)
  );
}

function isLoopbackV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && inV4Range(n, "127.0.0.0", 8);
}

/**
 * Expands any textual IPv6 address (compressed `::`, embedded dotted-quad tail such as
 * `::ffff:127.0.0.1`) into its 8 hextets. Returns null for anything that is not a valid IPv6
 * address. Classification below is NUMERIC: the WHATWG URL parser re-serializes IPv6 hostnames
 * into compressed hex groups (`new URL("https://[::ffff:127.0.0.1]/").hostname` is
 * `[::ffff:7f00:1]`), so any text/regex-based check on the spelling is bypassable.
 */
export function expandIpv6(rawAddress: string): number[] | null {
  let address = rawAddress.toLowerCase();
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  // Embedded IPv4 tail -> two hextets.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    address = `${address.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    return [...head, ...new Array<number>(missing).fill(0), ...rest];
  }
  return head.length === 8 ? head : null;
}

function v4FromTail(hextets: number[]): string {
  const hi = hextets[6] ?? 0;
  const lo = hextets[7] ?? 0;
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

/**
 * ::1 (loopback), :: (unspecified), fe80::/10 (link-local), fc00::/7 (unique-local),
 * IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 (both classified by their embedded IPv4),
 * plus anything unparsable (fail closed).
 */
function isBlockedV6(rawAddress: string): boolean {
  const h = expandIpv6(rawAddress);
  if (!h) return true;
  const allZero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (allZero(0, 7) && ((h[7] ?? 0) === 0 || (h[7] ?? 0) === 1)) return true; // :: and ::1
  if (allZero(0, 5) && h[5] === 0xffff) return isBlockedV4(v4FromTail(h)); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && allZero(2, 6)) return isBlockedV4(v4FromTail(h)); // 64:ff9b::a.b.c.d (NAT64)
  if (((h[0] ?? 0) & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (((h[0] ?? 0) & 0xfe00) === 0xfc00) return true; // fc00::/7
  return false;
}

function isLoopbackV6(rawAddress: string): boolean {
  const h = expandIpv6(rawAddress);
  if (!h) return false;
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isLoopbackV4(v4FromTail(h)); // ::ffff:127.x
  return false;
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
