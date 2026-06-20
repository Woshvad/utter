// @utter/data-proxy — the allowlisted egress proxy + short-lived resource-scoped
// token mint/verify + keyless upstream passthrough (SPEC §9.5, §17; CONTEXT
// "packages/data-proxy"). This is the ONLY permitted egress from a sandboxed
// resource (PRX-01/PRX-02).
//
// This is the Wave 0 barrel: the feature waves (Plan 03) append the host
// allowlist + SSRF-normalization checks (`allowlist.ts`), the short-lived
// resource-scoped JWT mint/verify (`token.ts` — HS256, aud=resourceId, tight
// exp, secret stays on the proxy), and the Hono proxy service (`proxy.ts` —
// verify token -> map resourceId -> upstream credential server-side -> forward).
//
// SECURITY NOTE: the container holds ONLY the short-lived scoped token, NEVER a
// real upstream API key. The proxy maps token -> resource -> allowlisted-upstream
// credential server-side, so the untrusted endpoint never sees a real key
// (SBX-03). Upstream allowance is an ALLOWLIST, never a denylist.

// Short-lived resource-scoped token mint/verify (HS256, aud=resourceId, tight exp).
export { mintResourceToken, verifyResourceToken } from "./token";

// Server-side token -> resource -> upstream credential mapping (keys never leave
// the proxy).
export {
  resolveUpstreamCredential,
  type UpstreamCredential,
  type CredentialResolver,
} from "./credentials";
