// siwe.server.ts - the STU-05 SIWE nonce + verify (ASVS V2, EIP-4361).
//
// The replay guard (T-06-SIWE-REPLAY, 06-RESEARCH Pitfall 7): the server issues a
// random nonce, stores it ON THE SESSION (one-time), and passes that SAME nonce to
// SiweMessage.verify({ nonce }). A captured message therefore cannot be replayed,
// because its nonce will not match a fresh session nonce, and the nonce is consumed
// on success. We ALSO bind the domain (verify({ domain })) so a signature minted for
// a different origin is rejected. We never hand-roll EIP-4361 parsing or signature
// recovery - the canonical `siwe` library does both (06-RESEARCH "Don't Hand-Roll").
//
// No private key ever reaches the server: only the message string + the signature
// cross the boundary; the browser signs via wagmi personal_sign. This module makes
// zero console.* calls - it never logs the signature or the nonce (T-06-LOGLEAK).
import { generateNonce, SiweMessage } from "siwe";

/** The session key the one-time SIWE nonce is stored under. */
export const SIWE_NONCE_KEY = "siweNonce" as const;

/**
 * Resolve the bound domain from the environment. SIWE_DOMAIN is the authority the
 * signed message must declare (the anti-phishing/origin bind). Falls back to the
 * dev host only so the autonomous path runs without provisioning.
 */
function siweDomain(): string {
  const fromEnv = process.env.SIWE_DOMAIN;
  return fromEnv && fromEnv.length > 0 ? fromEnv : "localhost";
}

/**
 * Issue a fresh server-side nonce. The caller stores it on the session (one-time)
 * and the browser embeds it in the SiweMessage it signs. generateNonce() returns a
 * >=8 alphanumeric token (the EIP-4361 minimum). Each call is fresh.
 */
export function issueNonce(): string {
  return generateNonce();
}

/**
 * Verify a signed SIWE message against the session-issued nonce + bound domain, and
 * return the authenticated address on success. Throws a 401 Response on any failure
 * (bad signature, nonce mismatch/absent, wrong domain, malformed message).
 *
 * Replay safety: `sessionNonce` is the one-time nonce the server issued and stored on
 * the session. We require it to be present and pass it to verify({ nonce }) so the
 * library rejects a message whose embedded nonce differs - the replay guard. The
 * caller MUST consume (delete) the session nonce after a successful verify so it
 * cannot be reused.
 *
 * @param message     the raw EIP-4361 message the wallet signed
 * @param signature   the wallet signature over `message`
 * @param sessionNonce the one-time nonce the server issued for this session
 * @returns the recovered, authenticated address
 */
export async function verifySiwe(
  message: string,
  signature: string,
  sessionNonce: string,
): Promise<string> {
  // No session nonce => nothing to bind against => reject (a verify without a
  // session-bound nonce is exactly the replay hole Pitfall 7 warns about).
  if (!sessionNonce || sessionNonce.length === 0) {
    throw unauthorized();
  }

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    // Malformed EIP-4361 message - reject without leaking the parse error detail.
    throw unauthorized();
  }

  let result;
  try {
    // Bind BOTH the one-time nonce AND the domain. siwe throws on a failed check
    // (default suppressExceptions=false), so we treat any throw as a 401.
    result = await siwe.verify({
      signature,
      nonce: sessionNonce,
      domain: siweDomain(),
    });
  } catch {
    throw unauthorized();
  }

  if (!result.success || !result.data?.address) {
    throw unauthorized();
  }
  return result.data.address;
}

/** A bare 401 Response with no secret material in the body. */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_signature" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
