// handler.ts - the TRUSTED in-process echo handler (Phase 2 money-path demo).
//
// This is a plain Hono handler that proves the end-to-end money path; it is NOT
// sandboxed (the gVisor/Firecracker isolation runtime lands in Phase 3 - CONTEXT
// lines 90-94). It exists solely to drive the deposit -> 402 -> 200 path behind
// the `requirePayment` gate, and its output shape is exactly what the response
// classifier validates against the echo `openapi.json`:
//
//   - SUCCESS (EchoSuccess): a string `text` input echoes `{ echo, length }`.
//   - DECLARED ERROR (EchoError): a non-string / missing / oversize `text` is the
//     buyer's bad input - the handler returns `{ error, code }` with HTTP 400. The
//     gate classifies this as `declared_error` (free policy: release, NO strike, no
//     debit) - a buyer's bad input must never wrongfully strike the creator.
//   - MALFUNCTION (test-only): `echoMalfunctionHandler` returns a body matching
//     NEITHER schema, to drive the malfunction branch (release + strike + NO debit).
//
// The handler never touches money, never reads a key, and never reaches the chain:
// the gate owns reservation/settle. It only shapes a schema-valid response.
import type { Context } from "hono";

/** The max input length the echo accepts before it is a declared (bad-input) error. */
export const ECHO_MAX_INPUT_LENGTH = 4096;

/** The request body the echo handler accepts: `{ text: string }`. */
interface EchoRequest {
  /** The string to echo back. A non-string / missing / oversize value is a declared error. */
  text?: unknown;
}

/**
 * The trusted in-process echo handler. Reads `{ text }` from the JSON body and:
 *   - returns 200 `{ echo, length }` (EchoSuccess) for a valid string `text`;
 *   - returns 400 `{ error, code }` (EchoError) for a non-string / missing /
 *     oversize `text` - a DECLARED error for the buyer's bad input (no strike).
 *
 * The gate (requirePayment) sits in front: it reserves the cap, runs this handler,
 * then classifies this body. This handler itself does no payment work.
 */
export async function echoHandler(c: Context): Promise<Response> {
  let body: EchoRequest;
  try {
    body = (await c.req.json()) as EchoRequest;
  } catch {
    // A malformed request body is the buyer's bad input (declared error, no strike).
    return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
  }

  const text = body?.text;
  if (typeof text !== "string") {
    // Bad buyer input: a declared error (EchoError) - the gate releases, never strikes.
    return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
  }
  if (text.length > ECHO_MAX_INPUT_LENGTH) {
    return c.json(
      { error: `text exceeds ${ECHO_MAX_INPUT_LENGTH} characters`, code: "TOO_LONG" },
      400,
    );
  }

  // Success (EchoSuccess): echo the text with its length.
  return c.json({ echo: text, length: text.length }, 200);
}

/**
 * A TEST-ONLY echo variant that returns a body matching NEITHER the success nor the
 * declared-error schema. It drives the MALFUNCTION branch of the gate: the gate
 * releases the reservation WITH a strikeReason (the facilitator records the strike),
 * returns 502, and NEVER debits. A genuinely broken endpoint is never charged and
 * the buyer is never billed for invalid output.
 */
export function echoMalfunctionHandler(c: Context): Response {
  // Matches neither EchoSuccess (needs echo:string + length:integer) nor EchoError
  // (needs error:string) - so the classifier returns "malfunction".
  return c.body(JSON.stringify({ unexpected: "field", length: "not-an-integer" }), 200, {
    "content-type": "application/json",
  });
}
