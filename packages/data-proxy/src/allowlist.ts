// allowlist.ts — host allowlist + SSRF normalization (PRX-02; RESEARCH
// Anti-Patterns "Using a denylist for upstream allowance" + Pattern 2 block set
// + OWASP SSRF "allowlist over denylist; normalize-then-validate").
//
// Two guards, applied in THIS order on an untrusted requested upstream:
//   1. normalize the host (lowercase, strip trailing dot, decode obfuscated IP
//      literals) and REJECT the link-local / metadata / private / loopback block
//      set (169.254/16, 10/8, 172.16/12, 192.168/16, 127/8, localhost) — even in
//      decimal/hex obfuscated forms (normalize THEN validate);
//   2. ONLY THEN check the data-driven ALLOWLIST (default-deny: a host not on the
//      list never passes). A denylist alone is bypass-prone (OWASP), so allowance
//      is positive.
//
// This is in-proxy enforcement. The netns/host firewall (Plan 02) is the
// defense-in-depth that makes the proxy the only route; this module makes the
// proxy itself refuse a private/non-allowlisted target. data-proxy keeps a LOCAL
// copy of the block-range shape and does NOT depend on services/sandbox.

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
 * Parse a host string into a 32-bit IPv4 integer if it is an IP literal in ANY of
 * the obfuscated forms an attacker might use (dotted-quad, single decimal, hex,
 * 0x-prefixed). Returns `null` when the host is not an IP literal (a real DNS
 * name). This is the "decode obfuscations before the range check" step.
 */
function parseIpv4Literal(host: string): number | null {
  // Dotted quad: 169.254.169.254
  const dotted = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const parts = dotted.slice(1, 5).map((p) => Number(p));
    if (parts.some((n) => n > 255)) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }
  // Single hex literal: 0x7f000001
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n >>> 0 : null;
  }
  // Single decimal literal: 2852039166
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n >>> 0 : null;
  }
  return null;
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
 * block set (incl. decimal/hex obfuscated IP literals) -> ONLY THEN allowlist.
 * Returns `{ ok:false }` on a malformed URL, a blocked literal, or a
 * non-allowlisted host. This is the in-proxy SSRF guard (PRX-02).
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

  // (1c) Decode obfuscated IPv4 literal forms and reject the block set.
  const ipv4 = parseIpv4Literal(host);
  if (ipv4 !== null) {
    if (isBlockedIpv4(ipv4)) return { ok: false };
    // A bare public IP literal is not an allowlisted DNS host -> default deny.
    return { ok: false };
  }

  // (2) ONLY THEN the default-deny allowlist on the DNS name.
  if (!isAllowlisted(host, allowlist)) return { ok: false };

  return { ok: true, host };
}
