// client-ip.server.ts - derive the rate-limit client key from a request (S2).
//
// TRUST RATIONALE (verified against the deployed topology): the studio publishes no
// host port and is reachable ONLY through Traefik (a documented deployment
// invariant), and Traefik v3 with no forwardedHeaders.trustedIPs configured STRIPS
// any client-supplied X-Forwarded-* headers and writes the real TCP peer address.
// So the LAST entry of x-forwarded-for is the Traefik-written peer, not something a
// client can forge. Residual risk: a first-party container on the ingress network
// could still forge the header; that trust rests on sidecar integrity, not on this
// module.

/**
 * The per-client rate-limit key for a request: the LAST x-forwarded-for entry,
 * trimmed. IPv6 addresses are bucketed to their /64 (join the first 4 hextets) so a
 * single v6 allocation cannot mint unlimited fresh keys. Falls back to "local" when
 * the header is absent (direct dev access, no proxy).
 */
export function clientIpKey(request: Request): string {
  const header = request.headers.get("x-forwarded-for");
  if (!header) return "local";
  const parts = header.split(",");
  const last = parts[parts.length - 1]!.trim();
  if (last.length === 0) return "local";
  if (last.includes(":") && !/^\d{1,3}(\.\d{1,3}){3}$/.test(last)) {
    // IPv6: bucket to the /64 by joining the first four hextets. Abbreviated forms
    // ("::") stay deterministic under split/join, which is all a bucket key needs.
    return last.split(":").slice(0, 4).join(":");
  }
  return last;
}
