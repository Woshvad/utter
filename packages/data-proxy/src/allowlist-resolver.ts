// allowlist-resolver.ts: per-resource egress allowlist resolution (H3).
//
// SECURITY (load-bearing, multi-tenant): on a shared proxy the egress allowlist
// MUST be a property of the VERIFIED resource, not a process-global. The proxy
// resolves the allowlist for the resourceId proven by the scoped token `aud`
// (after verifyResourceToken), exactly mirroring how `credentials.ts` resolves
// the upstream credential server-side. It is NEVER derived from a container-
// supplied value: a token minted for resource A cannot present `x-resource-id: B`
// to borrow B's allowlist, because the resourceId is the token-verified audience,
// not the raw header alone (the proxy 401s a header/aud mismatch before it ever
// reaches resolution).
//
// The map below is a DEV FIXTURE for tests + local wiring. In production the
// per-resource allowlist source is a server-side store keyed by resourceId (the
// same backend that will back the credential + quota stores); the resolver
// signature stays identical so the proxy code does not change when the backend is
// swapped. A persistent quota/allowlist store backend is a separate increment.

/**
 * The resolver seam: given the VERIFIED resourceId, return that resource's egress
 * allowlist (host patterns). Production injects a store-backed resolver with the
 * same shape; the global-`allowlist` opt is internally wrapped as a resolver that
 * returns the one list for every resource (dev/back-compat).
 *
 * A resolver MAY throw or return an empty list for an unmapped resource; the proxy
 * treats an empty/absent allowlist as default-deny (no host passes), failing
 * closed exactly like a missing credential.
 */
export type AllowlistResolver = (resourceId: string) => readonly string[];

/**
 * The dev/test per-resource allowlist fixture: resourceId -> that resource's
 * egress allowlist. Mirrors the credential fixture's resource ids so the two
 * resolve consistently in local wiring + tests.
 */
const DEV_ALLOWLIST_TABLE: Readonly<Record<string, readonly string[]>> = {
  "resource-aaaa-1111": ["api.openai.com"],
  "resource-bbbb-2222": ["api.weather.example.com"],
};

/**
 * Resolve the per-resource egress allowlist for `resourceId` from the dev fixture.
 *
 * Returns an empty list for an unmapped resource (default-deny: no host passes),
 * never a shared fallback list. Replaced by a store-backed resolver in production
 * via {@link AllowlistResolver}.
 */
export function resolveResourceAllowlist(resourceId: string): readonly string[] {
  return DEV_ALLOWLIST_TABLE[resourceId] ?? [];
}

/**
 * Wrap a single global allowlist as an {@link AllowlistResolver} that returns it
 * for every resource. This is the back-compat seam: the existing
 * `createDataProxy({ allowlist })` form keeps working unchanged (dev + the trusted
 * echo path), while the per-resource resolver is the production path. When the
 * global list is omitted the wrapped resolver returns an empty list (default-deny).
 */
export function globalAllowlistResolver(
  allowlist: readonly string[] | undefined,
): AllowlistResolver {
  const list = allowlist ?? [];
  return () => list;
}
