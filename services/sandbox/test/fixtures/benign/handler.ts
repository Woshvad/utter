// BENIGN control fixture (SBX-06 negative control) — the pre-publish scans must
// PASS this one. It mirrors the Phase 2 echo handler shape
// (packages/x402-arc/examples/echo/handler.ts): a clean, schema-shaped handler
// with no disallowed imports (no raw-socket / subprocess / datagram modules), no
// platform-environment enumeration, and no outbound network access. It is the
// proof the static scans do not false-positive on legitimate endpoint code.

import type { Context } from "hono";

/** The max input length the echo accepts before it is a declared (bad-input) error. */
export const BENIGN_MAX_INPUT_LENGTH = 4096;

/** The request body this handler accepts: `{ text: string }`. */
interface BenignRequest {
  /** The string to echo back. A non-string / missing / oversize value is a declared error. */
  text?: unknown;
}

/**
 * A clean echo-style handler. Returns 200 `{ echo, length }` for a valid string
 * `text`, or 400 `{ error, code }` for bad buyer input (a declared error). It
 * touches no env, opens no socket, and imports nothing on the deny-list.
 */
export async function benignHandler(c: Context): Promise<Response> {
  let body: BenignRequest;
  try {
    body = (await c.req.json()) as BenignRequest;
  } catch {
    return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
  }

  const text = body?.text;
  if (typeof text !== "string") {
    return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
  }
  if (text.length > BENIGN_MAX_INPUT_LENGTH) {
    return c.json(
      { error: `text exceeds ${BENIGN_MAX_INPUT_LENGTH} characters`, code: "TOO_LONG" },
      400,
    );
  }

  return c.json({ echo: text, length: text.length }, 200);
}
