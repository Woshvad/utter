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
 * The fields the session carries: `address` (the SIWE-authenticated creator) and
 * `siweNonce` (the one-time nonce consumed during the SIWE handshake). Typing the
 * storage explicitly keeps session.get/set type-safe across routes and tests.
 */
interface SessionData {
  address: string;
  siweNonce: string;
}

/** The minimum byte length we require of a real SESSION_SECRET in production. */
const MIN_SECRET_LENGTH = 32;

/**
 * Resolve the cookie signing secret from the environment. SESSION_SECRET lives in
 * .env.local only; it is never hardcoded or committed. The check is LAZY (run only
 * when the secret is actually needed, never at module top-level) so importing this
 * module - as the test suite does - never crashes.
 *
 * Fail-closed in production: when NODE_ENV is "production" we REQUIRE a real
 * SESSION_SECRET that is non-empty after trim AND at least 32 chars; otherwise we
 * throw, because the committed dev constant is a publicly known HMAC key and using
 * it in production would let anyone forge a session cookie for any address (bypassing
 * every requireCreator gate). We NEVER return the dev constant in production.
 *
 * Outside production (development/test): fall back to a clearly-non-production
 * placeholder ONLY when SESSION_SECRET is unset, so local dev and the autonomous
 * suite run without a provisioned secret. The raw value is never logged.
 */
export function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;

  if (process.env.NODE_ENV === "production") {
    const trimmed = (fromEnv ?? "").trim();
    if (trimmed.length < MIN_SECRET_LENGTH) {
      // Fail loud. Do not echo the (missing/short) secret; just tell the operator.
      throw new Error(
        "SESSION_SECRET must be set to a non-empty value of at least " +
          `${MIN_SECRET_LENGTH} characters in production. Set SESSION_SECRET in the ` +
          "deployment environment (.env.local / secrets manager); the dev fallback is " +
          "never used in production.",
      );
    }
    return fromEnv as string;
  }

  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Dev/test-only fallback (never a real secret). Operators set SESSION_SECRET in
  // .env.local; this branch keeps the autonomous suite runnable without leaking or
  // requiring a real secret. NOT used in production and NOT used when SESSION_SECRET
  // is present.
  return "utter-studio-dev-only-session-secret-not-for-production";
}

/**
 * The signed httpOnly session storage, built lazily on first use. We do NOT call
 * createCookieSessionStorage at module top-level because that would force the
 * sessionSecret() check to run merely on import - which must not crash the test
 * suite. Instead the storage is constructed the first time getSession/commitSession/
 * destroySession is invoked, at which point a missing production secret fails loud.
 * createCookieSessionStorage owns the HMAC; we never sign cookies by hand. `secrets`
 * is an array so a future secret rotation can prepend a new value while still
 * verifying cookies signed with the old one.
 */
type SessionStorage = ReturnType<typeof createCookieSessionStorage<SessionData>>;
let cachedStorage: SessionStorage | null = null;

function getStorage(): SessionStorage {
  if (cachedStorage) return cachedStorage;
  cachedStorage = createCookieSessionStorage<SessionData>({
    cookie: {
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      secrets: [sessionSecret()],
    },
  });
  return cachedStorage;
}

/**
 * The session storage facade. Exposes the same getSession/commitSession/destroySession
 * trio as createCookieSessionStorage, but each method resolves the real storage lazily
 * via getStorage() so the secret check is deferred to first use (never on import).
 */
export const sessionStorage: SessionStorage = {
  getSession: (...args) => getStorage().getSession(...args),
  commitSession: (...args) => getStorage().commitSession(...args),
  destroySession: (...args) => getStorage().destroySession(...args),
};

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
