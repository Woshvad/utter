// facilitator-token.ts - the deployer-side per-resource caller-auth token MINT helper
// (Security review C1, wave BC1).
//
// At deploy time the operator mints ONE token per resource bound to that resourceId
// and injects it into the trusted SIDECAR container (SIDECAR_FACILITATOR_TOKEN) so the
// gate can present `Authorization: Bearer <token>` to the facilitator. The untrusted
// handler container NEVER receives this token. This helper is the deploy-side wrapper
// over the facilitator's already-built+enforced mintResourceAuthToken: it validates
// the secret up front so a misconfig fails loud at deploy time rather than silently
// 401-ing every paid call, then delegates the HMAC to the facilitator (the HMAC is
// owned in ONE place; it is never reimplemented here).
//
// SECURITY: this helper NEVER reads process.env and NEVER logs the secret or the
// minted token. The caller (wave BC2) reads FACILITATOR_AUTH_SECRET from the
// environment and passes it in; the returned token is injected into the sidecar env
// and is never written to a log.
import { mintResourceAuthToken } from "@utter/facilitator/index";
import type { Hex } from "viem";

/**
 * The minimum caller-auth secret length, mirroring the facilitator's production
 * requirement (MIN_AUTH_SECRET_LENGTH in services/facilitator/src/server.ts
 * resolveAuthConfig). A shorter secret is rejected at deploy time so a weak/blank
 * secret cannot ship and 401 every paid call.
 */
export const MIN_FACILITATOR_AUTH_SECRET_LENGTH = 32;

/** Options for {@link mintFacilitatorToken}. */
export interface MintFacilitatorTokenOpts {
  /** The resource the token authorizes (bytes32 Hex) - the bound rid claim. */
  resourceId: Hex;
  /**
   * The facilitator caller-auth secret. The CALLER reads this from env
   * (FACILITATOR_AUTH_SECRET) and passes it in; this helper never reads process.env.
   * Must be present and at least {@link MIN_FACILITATOR_AUTH_SECRET_LENGTH} chars.
   */
  secret: string;
  /**
   * Optional time-to-live in seconds. Omitted by default: the design decision is a
   * NON-EXPIRING token for the trusted long-lived sidecar (rid-bound, so a leak is
   * scoped to one resource and the facilitator secret can be rotated to revoke).
   */
  ttlSeconds?: number;
}

/**
 * Mint a per-resource caller-auth token for the SIDECAR, reusing the facilitator's
 * mintResourceAuthToken (the canonical HMAC - never reimplemented here).
 *
 * Validates the secret is present and at least
 * {@link MIN_FACILITATOR_AUTH_SECRET_LENGTH} chars BEFORE minting: a blank/short
 * secret throws a clear, VALUE-FREE error so a misconfig fails loud at deploy time
 * instead of silently producing a token the facilitator rejects (401 on every paid
 * call). Defaults to a non-expiring token; pass ttlSeconds only for a short-lived one.
 *
 * NEVER logs the secret or the returned token.
 */
export function mintFacilitatorToken(opts: MintFacilitatorTokenOpts): string {
  const secret = typeof opts.secret === "string" ? opts.secret.trim() : "";
  if (secret.length < MIN_FACILITATOR_AUTH_SECRET_LENGTH) {
    // Fail loud, value-free: never echo the (missing/short) secret.
    throw new Error(
      `facilitator auth secret must be a non-empty value of at least ` +
        `${MIN_FACILITATOR_AUTH_SECRET_LENGTH} characters to mint a sidecar token ` +
        `(set FACILITATOR_AUTH_SECRET); a short or blank secret would 401 every paid call.`,
    );
  }

  // Reuse the facilitator's HMAC. Omitting ttlSeconds yields a non-expiring token.
  return mintResourceAuthToken(opts.resourceId, secret, { ttlSeconds: opts.ttlSeconds });
}
