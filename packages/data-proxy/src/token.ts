// token.ts — short-lived resource-scoped token mint/verify (SBX-03, PRX-01;
// RESEARCH Pattern 3, Don't-Hand-Roll "Scoped token").
//
// The container holds ONLY this signed token, NEVER a real upstream key. The
// token binds to ONE resource via `aud=resourceId` and expires fast (tight TTL,
// 60-120s) to bound replay (Security Domain "Replay of scoped token"). HS256
// keeps the verifying secret on the proxy, so a container cannot forge a token.
// The payload carries ONLY `aud` (+ jwt's `iat`/`exp`); a real upstream
// credential is NEVER part of the token — it is resolved server-side in
// `credentials.ts` and injected only on the proxy->upstream leg.
import jwt from "jsonwebtoken";

/**
 * Mint a short-lived resource-scoped token for `resourceId`.
 *
 * HS256-signed (secret stays on the proxy), `audience=resourceId` binds it to a
 * single resource, `expiresIn=ttlSeconds` bounds replay. Keep `ttlSeconds` tight
 * (60-120s per CONTEXT/RESEARCH). The payload deliberately carries no credential
 * material — only the audience claim.
 */
export function mintResourceToken(resourceId: string, ttlSeconds: number, secret: string): string {
  return jwt.sign({}, secret, {
    algorithm: "HS256",
    audience: resourceId,
    expiresIn: ttlSeconds,
  });
}

/**
 * Verify a resource-scoped token for `resourceId`.
 *
 * Returns `true` only when the token is HS256-signed by `secret`, unexpired, and
 * its `aud` equals `resourceId`. Any failure (bad signature, wrong audience,
 * expiry, tampering, alg confusion / `none`) is caught and returns `false` — the
 * proxy treats a non-`true` result as a hard 401 with no forward. We pin
 * `algorithms:['HS256']` so a forged `alg:none` (or RS/HS confusion) token can
 * never verify.
 */
export function verifyResourceToken(token: string, resourceId: string, secret: string): boolean {
  try {
    jwt.verify(token, secret, { algorithms: ["HS256"], audience: resourceId });
    return true;
  } catch {
    return false;
  }
}
