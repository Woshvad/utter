// allowlist.ts — host allowlist + SSRF normalization (PRX-02; RESEARCH
// Anti-Patterns "Using a denylist for upstream allowance" + Pattern 2 block set
// + OWASP SSRF "allowlist over denylist; normalize-then-validate").
//
// Guards, applied in THIS order on an untrusted requested upstream:
//   1. normalize the host (lowercase, strip trailing dot, decode obfuscated IP
//      literals) and REJECT the link-local / metadata / private / loopback block
//      set (169.254/16, 10/8, 172.16/12, 192.168/16, 127/8, 0/8, localhost, and
//      the IPv6 ::1 / fe80::/10 / fc00::/7 equivalents) — even in
//      decimal/hex/octal obfuscated forms (normalize THEN validate);
//   2. check the data-driven ALLOWLIST (default-deny: a host not on the list
//      never passes). A denylist alone is bypass-prone (OWASP), so allowance is
//      positive;
//   3. for a DNS name that passes (1) and (2), RESOLVE it and re-check EVERY
//      resolved A/AAAA address against the SAME block set, so an allowlisted
//      record that points at a private/metadata address (DNS rebinding or a
//      malicious allowlisted record) is rejected. The resolved address is
//      returned so the proxy can pin-and-connect to it (closing the TOCTOU).
//
// The literal/allowlist checks in (1)+(2) are SYNCHRONOUS (the fast pre-filter,
// {@link normalizeAndCheckHost}); the resolve-and-recheck in (3) is ASYNC
// ({@link resolveAndCheckHost}) because it does DNS. The proxy runs the sync
// pre-filter first, then the async resolution before forwarding.
//
// This is in-proxy enforcement. The netns/host firewall (Plan 02) is the
// defense-in-depth that makes the proxy the only route; this module makes the
// proxy itself refuse a private/non-allowlisted target. data-proxy keeps a LOCAL
// copy of the block-range shape and does NOT depend on services/sandbox.
import { lookup } from "node:dns/promises";

/**
 * The default data-driven upstream allowlist (dev fixture). Adding an upstream is
 * a data edit here (or a custom list passed to {@link normalizeAndCheckHost}),
 * never a logic change. In production this is sourced per-resource.
 */
export const DEFAULT_ALLOWLIST = ["api.openai.com"] as const;

/**
 * SSRF block ranges — link-local/metadata, RFC1918 private, and loopback. Mirrors
 * the RESEARCH Pattern 2 `EGRESS_BLOCK_SET` (local copy; no cross-package dep).
 * Each entry is `[firstOctet-or-prefix predicate]`; applied to a parsed dotted-quad.
 */
const PRIVATE_HOSTNAMES = new Set(["localhost"]);

/** True if `ip` (a 32-bit unsigned int) falls in a blocked SSRF range. */
function isBlockedIpv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8 RFC1918
  if (a === 10) return true;
  // 169.254.0.0/16 link-local + cloud metadata (169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 RFC1918
  if (a === 192 && b === 168) return true;
  // 0.0.0.0/8 (this-host / unspecified) — also unsafe to forward to.
  if (a === 0) return true;
  return false;
}

/**
 * True if `ip` (a lowercased, normalized IPv6 string) is a blocked SSRF target:
 * loopback `::1`, unspecified `::`, link-local `fe80::/10`, unique-local
 * `fc00::/7`, an IPv4-mapped/compatible address whose embedded IPv4 is blocked,
 * or an IPv4 dotted form embedded in IPv6 text. Conservative: anything we cannot
 * positively classify as a public global address is left to the caller (the
 * default allowlist is DNS-name based, so a bare IPv6 literal never passes the
 * allowlist anyway — this guard exists for the RESOLVED-address re-check).
 */
function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true;
  // Link-local fe80::/10 (fe80..febf) and unique-local fc00::/7 (fc00..fdff).
  if (/^fe[89ab][0-9a-f]?:/.test(v)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return true;
  if (/^f[cd]:/.test(v)) return true;
  // IPv4-mapped / IPv4-compatible (e.g. ::ffff:169.254.169.254): pull the
  // embedded dotted-quad and run it through the IPv4 block check.
  const embedded = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded && embedded[1]) {
    const asV4 = parseDottedQuad(embedded[1]);
    if (asV4 !== null && isBlockedIpv4(asV4)) return true;
  }
  return false;
}

/** Parse a strict dotted-quad to a 32-bit int, or null. Each octet base-10, <=255. */
function parseDottedQuad(host: string): number | null {
  const dotted = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!dotted) return null;
  const parts = dotted.slice(1, 5).map((p) => Number(p));
  if (parts.some((n) => n > 255)) return null;
  const [a, b, c, d] = parts as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Does `host` LOOK numeric (an IP-literal-ish form an attacker might use to
 * obfuscate a private target)? Covers any all-digit run, a `0x` hex form, and a
 * dotted form whose components are all numeric (decimal/hex/octal). A host that
 * looks numeric but is NOT a clean public dotted-quad is rejected outright rather
 * than risk mis-parsing its radix (WR-02): we never let a numeric-looking host
 * reach the allowlist.
 */
function looksNumericHost(host: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // single hex literal
  if (/^\d+$/.test(host)) return true; // single decimal/octal literal
  // Dotted form where EVERY component is numeric (decimal, 0x-hex, or 0-octal).
  if (host.includes(".")) {
    const parts = host.split(".");
    if (parts.length >= 2 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a host string into a 32-bit IPv4 integer if it is a CLEAN dotted-quad in
 * the standard base-10 form (e.g. 169.254.169.254). Returns `null` for anything
 * else (a real DNS name, OR an obfuscated numeric form — those are handled by
 * {@link looksNumericHost}, which rejects them before they reach the allowlist so
 * a mis-parsed radix can never smuggle a private target through).
 */
function parseIpv4Literal(host: string): number | null {
  return parseDottedQuad(host);
}

/** Lowercase + strip a single trailing dot (FQDN root). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Default-deny allowlist check: `true` only when `host` (case-insensitive, exact)
 * is on the allowlist. A subdomain spoof (`api.openai.com.evil.com`) does not match.
 */
export function isAllowlisted(
  host: string,
  allowlist: readonly string[] = DEFAULT_ALLOWLIST,
): boolean {
  const normalized = normalizeHost(host);
  return allowlist.some((entry) => normalizeHost(entry) === normalized);
}

/** Result of {@link normalizeAndCheckHost}. */
export interface HostCheckResult {
  /** Whether the requested upstream passed both the SSRF block AND the allowlist. */
  ok: boolean;
  /** The normalized host (when parseable); useful for the proxy log/forward. */
  host?: string;
}

/**
 * Normalize a requested upstream URL (or bare host) and validate it for forwarding.
 *
 * Order is load-bearing: parse -> normalize -> REJECT the SSRF/private/loopback
 * block set (incl. decimal/hex/octal obfuscated IP literals) -> ONLY THEN
 * allowlist. Returns `{ ok:false }` on a malformed URL, a blocked literal, or a
 * non-allowlisted host. This is the SYNCHRONOUS in-proxy SSRF pre-filter (PRX-02);
 * for a DNS name the resolved address is NOT yet checked here — call
 * {@link resolveAndCheckHost} before forwarding to close the rebinding gap.
 */
export function normalizeAndCheckHost(
  urlOrHost: string,
  allowlist: readonly string[] = DEFAULT_ALLOWLIST,
): HostCheckResult {
  if (!urlOrHost || typeof urlOrHost !== "string") return { ok: false };

  // Parse the host out of a URL; accept a bare host by prefixing a scheme.
  let rawHost: string;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)
      ? urlOrHost
      : `http://${urlOrHost}`;
    rawHost = new URL(candidate).hostname;
  } catch {
    return { ok: false };
  }
  if (!rawHost) return { ok: false };

  // URL() lowercases DNS names and brackets IPv6; strip brackets + trailing dot.
  const host = normalizeHost(rawHost.replace(/^\[|\]$/g, ""));

  // (1) Block named loopback.
  if (PRIVATE_HOSTNAMES.has(host)) return { ok: false };

  // (1b) Block any IPv6 literal outright (the dev allowlist is DNS-name based; an
  // IPv6 literal is never a legitimate allowlisted upstream and ::1 / unique-local
  // are SSRF targets). Reject conservatively.
  if (host.includes(":")) return { ok: false };

  // (1c) Reject any numeric-looking host outright (decimal/hex/octal single or
  // dotted forms). A clean public dotted-quad is still not an allowlisted DNS
  // host, so we reject ALL numeric hosts here rather than risk mis-parsing a
  // radix (WR-02: a leading-zero octet like 0177.0.0.1 must never be read as
  // decimal and slip past the block set).
  if (looksNumericHost(host)) {
    const ipv4 = parseIpv4Literal(host);
    // Whether it decodes to a blocked literal or not, a numeric host is never an
    // allowlisted DNS name -> default deny.
    if (ipv4 !== null && isBlockedIpv4(ipv4)) return { ok: false };
    return { ok: false };
  }

  // (2) ONLY THEN the default-deny allowlist on the DNS name.
  if (!isAllowlisted(host, allowlist)) return { ok: false };

  return { ok: true, host };
}

/** A resolved + block-checked address ready to pin-and-connect to. */
export interface ResolvedHostResult {
  /** True only when the host passed the sync pre-filter AND every resolved IP is public. */
  ok: boolean;
  /** The normalized DNS host (when the pre-filter passed). */
  host?: string;
  /**
   * The validated resolved addresses (every one passed the block-set re-check).
   * The proxy pins its outbound connection to `addresses[0]` so a rebind between
   * this check and the connect cannot redirect the forward.
   */
  addresses?: { address: string; family: 4 | 6 }[];
  /** Why it was rejected (for a 403 reason / log; never carries secret material). */
  reason?: "pre_filter" | "resolved_to_blocked" | "resolve_failed" | "no_addresses";
}

/** Seam: resolve a host to all A/AAAA records. Injectable so tests stub DNS. */
export type DnsLookupAll = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

/** Default DNS resolver: Node `dns.lookup` with `{ all: true }`. */
const defaultLookupAll: DnsLookupAll = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * Resolve `urlOrHost` and validate EVERY resolved A/AAAA address against the
 * SAME block set the literal pre-filter uses. This closes the DNS-rebinding /
 * malicious-allowlisted-record gap (CR-02): an allowlisted name that resolves to
 * 169.254.169.254 / 127.0.0.1 / RFC1918 / IPv6 loopback-or-ULA is REJECTED.
 *
 * Runs {@link normalizeAndCheckHost} first (fast literal + allowlist pre-filter),
 * then resolves and re-checks. Returns the validated addresses so the proxy can
 * pin-and-connect to a checked IP (the TOCTOU close). Rejects if resolution
 * fails, yields no addresses, or ANY resolved address is in the block set.
 */
export async function resolveAndCheckHost(
  urlOrHost: string,
  allowlist: readonly string[] = DEFAULT_ALLOWLIST,
  lookupAll: DnsLookupAll = defaultLookupAll,
): Promise<ResolvedHostResult> {
  const pre = normalizeAndCheckHost(urlOrHost, allowlist);
  if (!pre.ok || !pre.host) return { ok: false, reason: "pre_filter" };

  let records: { address: string; family: number }[];
  try {
    records = await lookupAll(pre.host);
  } catch {
    return { ok: false, host: pre.host, reason: "resolve_failed" };
  }
  if (!records || records.length === 0) {
    return { ok: false, host: pre.host, reason: "no_addresses" };
  }

  const validated: { address: string; family: 4 | 6 }[] = [];
  for (const rec of records) {
    if (rec.family === 6) {
      if (isBlockedIpv6(rec.address)) {
        return { ok: false, host: pre.host, reason: "resolved_to_blocked" };
      }
      validated.push({ address: rec.address, family: 6 });
      continue;
    }
    // Treat anything non-6 as IPv4. Parse the dotted-quad and run the block check.
    const asV4 = parseDottedQuad(rec.address);
    if (asV4 === null || isBlockedIpv4(asV4)) {
      return { ok: false, host: pre.host, reason: "resolved_to_blocked" };
    }
    validated.push({ address: rec.address, family: 4 });
  }

  return { ok: true, host: pre.host, addresses: validated };
}
