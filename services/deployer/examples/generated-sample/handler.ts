// SAMPLE untrusted generated bundle for the operator host runbook (DEPLOY_BUNDLE_PATH).
// This is a stand-in for a studio-generated bundle the operator can point
// DEPLOY_BUNDLE_PATH at when walking the generated-bundle deploy in
// infrastructure/RUNBOOK.md. It is kept deliberately benign so the pre-build static
// gate (services/deployer/src/gate-bundle.ts) passes it and the live deploy yields a
// clean 402->200. The body mirrors the proven benign fixture
// (services/deployer/test/fixtures/generated-benign/handler.ts), with the success body
// keyed `echo` (not `result`) so it validates against this bundle's openapi.json
// classifier. The handler stays UNTRUSTED code: the static gate scans it before any build.
//
// BENIGN generated-handler fixture (deploy plane B, source-only) - the clean
// generated-shape handler the bundle-generated build core and the pre-build gate
// must both accept. It mirrors the generated template
// (packages/ai-runtime/skills/templates/handler.ts.tmpl) and the sandbox benign
// fixture: a plain Hono handler that parses { text }, returns a 400 declared error
// for bad buyer input, and a 200 success body otherwise.
//
// It imports only the Context type from hono, touches no env, opens no socket, and
// imports nothing on the static deny-list, so the pre-build gate passes it. The
// trusted shim imports THIS named `handler` export (the template export name).
import type { Context } from "hono";

/** The max input length accepted before it is a declared (bad-input) error. */
export const MAX_INPUT_LENGTH = 4096;

/** The request body this handler accepts. A non-string `text` is a declared error. */
interface ResourceRequest {
  text?: unknown;
}

/**
 * The generated handler. Reads `{ text }` from the JSON body and returns either a
 * 200 success body or a 400 declared error for the buyer's bad input. The sidecar
 * gate in front owns the money path; this handler only shapes a schema-valid response.
 */
export async function handler(c: Context): Promise<Response> {
  let body: ResourceRequest;
  try {
    body = (await c.req.json()) as ResourceRequest;
  } catch {
    return c.json({ error: "request body must be valid JSON", code: "BAD_JSON" }, 400);
  }

  const text = body?.text;
  if (typeof text !== "string") {
    return c.json({ error: "text must be a string", code: "BAD_INPUT" }, 400);
  }
  if (text.length > MAX_INPUT_LENGTH) {
    return c.json(
      { error: `text exceeds ${MAX_INPUT_LENGTH} characters`, code: "TOO_LONG" },
      400,
    );
  }

  // Success: echo the text with its length. The key is `echo` (NOT `result`) so the
  // body validates against this bundle's openapi.json classifier (EchoSuccess requires
  // { echo, length }, additionalProperties:false); a mismatch makes the response gate
  // classify it a malfunction (502, no debit). The guard test runs this handler and
  // classifies its output to keep handler and classifier in lockstep.
  return c.json({ echo: text, length: text.length }, 200);
}
