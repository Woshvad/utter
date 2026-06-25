// resource-auth.ts - the per-resource caller-auth token (Security review C1).
//
// The facilitator money/control routes (/verify, /settle, /release) act on a
// specific resourceId. Without caller auth, ANY peer can call them for ANY
// resourceId - forging strikes, replaying releases, or self-settling against a
// resource it does not own. This module mints and verifies a small HMAC token
// whose authenticated claim is a single resourceId, so a caller may only act on
// the resource its token is bound to.
//
// The token mirrors the data-proxy scoped-token pattern (packages/data-proxy/
// src/token.ts) but uses node:crypto directly (no new dependency): an HMAC-SHA256
// over a compact JSON payload, both halves base64url-encoded and joined by a dot.
// The verifying secret stays on the facilitator, so a caller cannot forge a token.
// The verify path uses crypto.timingSafeEqual so a wrong signature cannot be
// distinguished by timing. The token and the secret are NEVER logged here.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";

/** The authenticated payload: the bound resourceId (+ an optional expiry, unix seconds). */
interface TokenPayload {
  /** The single resourceId this token authorizes. */
  rid: Hex;
  /** Optional expiry (unix seconds). When present, an elapsed token verifies to null. */
  exp?: number;
}

/** Options for {@link mintResourceAuthToken}. */
export interface MintOpts {
  /** Optional time-to-live in seconds; when set the token carries an `exp` claim. */
  ttlSeconds?: number;
  /** Injected clock (unix seconds) for the `exp` computation. Defaults to Date.now. */
  now?: () => number;
}

/** base64url-encode a buffer (no padding) - URL/header-safe token halves. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compute the HMAC-SHA256 of `data` under `secret`, returned as a base64url string. */
function sign(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/**
 * Mint a per-resource caller-auth token bound to `resourceId`.
 *
 * The token is `base64url(payload).base64url(hmac)` where the HMAC is taken over
 * the encoded payload under `secret`. The authenticated claim is the resourceId
 * (plus an optional expiry). For the deployer/operator to mint one token per
 * resource at deploy time. The secret is never embedded in the token.
 */
export function mintResourceAuthToken(resourceId: Hex, secret: string, opts?: MintOpts): string {
  const payload: TokenPayload = { rid: resourceId };
  if (opts?.ttlSeconds !== undefined && opts.ttlSeconds > 0) {
    const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
    payload.exp = nowSec + opts.ttlSeconds;
  }
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

/**
 * Verify a per-resource caller-auth token and return its bound resourceId, or
 * null on any failure.
 *
 * Recomputes the HMAC over the payload half and compares it to the presented MAC
 * with crypto.timingSafeEqual (constant time, so a near-miss signature cannot be
 * brute-forced by timing). Returns null on a malformed token, a length mismatch,
 * a wrong/forged signature, or an elapsed expiry. The caller treats null as a
 * hard reject (401). Never logs the token or the secret.
 */
export function verifyResourceAuthToken(
  token: string,
  secret: string,
): { resourceId: Hex } | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const presentedMac = token.slice(dot + 1);

  const expectedMac = sign(encoded, secret);
  // Constant-time compare. timingSafeEqual throws on a length mismatch, so guard
  // the length first (a length difference is already a non-match and is not secret).
  const a = Buffer.from(presentedMac, "utf8");
  const b = Buffer.from(expectedMac, "utf8");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let payload: TokenPayload;
  try {
    const json = Buffer.from(
      encoded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.rid !== "string" || payload.rid.length === 0) return null;
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { resourceId: payload.rid };
}
