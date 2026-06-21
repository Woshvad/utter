// session.server.ts - the STU-05 signed httpOnly session cookie (ASVS V3).
//
// The session cookie is the authentication token gating creator-only routes. It is
// built with @react-router/node createCookieSessionStorage so the cookie HMAC is
// NEVER hand-rolled (06-RESEARCH "Don't Hand-Roll" + Pattern 3): the framework signs
// with the secrets[] array and rejects a tampered cookie (T-06-COOKIE-TAMPER). The
// signing secret comes from SESSION_SECRET in the environment (.env.local only -
// never hardcoded, never committed, never logged); SESSION_SECRET reaching a log
// line is the T-06-LOGLEAK threat, so this module makes zero console.* calls and
// never echoes the secret.
//
// Cookie flags: httpOnly (JS cannot read it), secure (HTTPS only), SameSite=lax
// (the CSRF baseline for state-changing creator actions, T-06-CSRF), path "/".
//
// The session carries a single field: `address` - the SIWE-authenticated creator
// address. The nonce issued during the SIWE handshake is also stored on the session
// (one-time, consumed on verify) by siwe.server.ts.
// createCookieSessionStorage is exported from the framework runtime (`react-router`
// re-exports it); @react-router/node only ships the file-backed variant. We use the
// cookie-backed signed session - the framework owns the HMAC (never hand-rolled).
import { createCookieSessionStorage } from "react-router";

/** The session-cookie name (06-RESEARCH Pattern 3). */
const SESSION_COOKIE_NAME = "__utter_session";

/**
 * Resolve the cookie signing secret from the environment. SESSION_SECRET lives in
 * .env.local only; it is never hardcoded or committed. We read it lazily (at module
 * load) and fall back to a clearly-non-production placeholder ONLY so the autonomous
 * test/dev path can run without a provisioned secret - a real deployment MUST set
 * SESSION_SECRET. The raw value is never logged.
 */
function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Dev/test-only fallback (never a real secret). Operators set SESSION_SECRET in
  // .env.local; this branch keeps the autonomous suite runnable without leaking or
  // requiring a real secret. NOT used when SESSION_SECRET is present.
  return "utter-studio-dev-only-session-secret-not-for-production";
}

/**
 * The signed httpOnly session storage. createCookieSessionStorage owns the HMAC;
 * we never sign cookies by hand. `secrets` is an array so a future secret rotation
 * can prepend a new value while still verifying cookies signed with the old one.
 */
export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    secrets: [sessionSecret()],
  },
});

/** Re-export the trio the routes/gate use, so callers import from one place. */
export const { getSession, commitSession, destroySession } = sessionStorage;

/**
 * Read the SIWE-authenticated creator address from a request's session cookie, or
 * null when the request is unauthenticated. Used by requireCreator (the access gate)
 * and by loaders that need the current creator. Reads ONLY the `address` field; the
 * tamper-proof signed cookie is the trust anchor.
 */
export async function getAuthAddress(request: Request): Promise<string | null> {
  const session = await getSession(request.headers.get("Cookie"));
  const address = session.get("address");
  return typeof address === "string" && address.length > 0 ? address : null;
}
