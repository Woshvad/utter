// classify.ts - the AJV response classifier (PAY-06, RESEARCH Pattern 5).
//
// buildClassifier(openapi) compiles the echo `openapi.json` success + declared-
// error schemas (AJV strict:false + ajv-formats for the OpenAPI dialect) and
// returns classifyResponse(body):
//   - validates EchoSuccess -> "success"        (charge min(computed, cap))
//   - else validates EchoError -> "declared_error" (buyer bad input; error policy, NO strike)
//   - else / non-JSON / unparseable -> "malfunction" (release, record strike, never debit)
//
// The declared_error vs malfunction split is the wrongful-strike guard: a buyer's
// bad input (a declared error) must never strike the creator (Plan 04 consumes this).
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/** The three response classes the escrow gate branches on. */
export type ResponseClass = "success" | "declared_error" | "malfunction";

/** A bound classifier: maps a response body to its class. */
export type ClassifyResponse = (body: unknown) => ResponseClass;

const SUCCESS_REF = "openapi.json#/components/schemas/EchoSuccess";
const ERROR_REF = "openapi.json#/components/schemas/EchoError";

/** Optional resource-named schema refs for a generated openapi. */
export interface ClassifierRefs {
  /** The success schema ref; defaults to the echo `EchoSuccess` ref. */
  successRef?: string;
  /** The declared-error schema ref; defaults to the echo `EchoError` ref. */
  errorRef?: string;
}

/**
 * Find the single `*Success` or `*Error` component-schema ref in an openapi doc by
 * the name suffix. This mirrors validate.ts findSchemaRefs semantics, replicated
 * locally so x402-arc carries no dependency on the deploy layer. The pick is
 * deterministic: names are sorted before matching so it never depends on object-key
 * insertion order. Returns the `openapi.json#/components/schemas/<name>` ref ONLY
 * when EXACTLY ONE name matches the suffix; returns undefined for zero matches OR
 * more than one match. Ambiguity resolving to undefined is the fail-closed property:
 * the caller then falls back to the Echo default ref, which is absent in a non-echo
 * doc, so the throw-if-missing after resolution fires.
 */
function discoverComponentRef(
  doc: Record<string, unknown>,
  suffix: "Success" | "Error",
): string | undefined {
  const components = doc.components as { schemas?: Record<string, unknown> } | undefined;
  const schemas = components?.schemas ?? {};
  const names = Object.keys(schemas).sort();
  const matches = names.filter((n) => n.endsWith(suffix));
  if (matches.length !== 1) return undefined;
  return `openapi.json#/components/schemas/${matches[0]}`;
}

/**
 * Compile an openapi doc into a classifier. The success and declared-error schema
 * refs are resolved by this precedence: explicit `{ successRef, errorRef }` opts win,
 * else the single `*Success` / `*Error` component schema is discovered by name suffix
 * (so a studio-generated bundle's `ResourceSuccess`/`ResourceError`, or a model's
 * `<Name>Success`/`<Name>Error`, classifies with no opts), else the echo defaults
 * `EchoSuccess`/`EchoError`. The doc must carry `$id:"openapi.json"` (set here if
 * absent). Throws at build time if a resolved ref is absent or uncompilable so a
 * misconfigured or ambiguous resource fails loudly rather than silently classifying
 * everything as malfunction. Ambiguity (more than one `*Success`) resolves to the
 * echo default, which is absent in a non-echo doc, so the throw still fires.
 */
export function buildClassifier(
  openapi: Record<string, unknown>,
  opts?: ClassifierRefs,
): ClassifyResponse {
  // strict:false tolerates the OpenAPI 3.1 dialect; addFormats supplies
  // date-time/uri/email/etc. AJV would otherwise omit.
  const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
  // Clone the doc before setting `$id` so we never mutate the caller's object (a
  // shared/frozen openapi doc would otherwise be mutated or throw) - IN-05.
  const doc = { ...openapi };
  if (doc.$id === undefined) {
    doc.$id = "openapi.json";
  }
  ajv.addSchema(doc);

  // Resolve refs AFTER `$id` is set so the discovered `openapi.json#...` prefix
  // matches what ajv.getSchema resolves: explicit opts -> suffix discovery -> Echo.
  const successRef = opts?.successRef ?? discoverComponentRef(doc, "Success") ?? SUCCESS_REF;
  const errorRef = opts?.errorRef ?? discoverComponentRef(doc, "Error") ?? ERROR_REF;

  const validateSuccess: ValidateFunction | undefined = ajv.getSchema(successRef);
  const validateError: ValidateFunction | undefined = ajv.getSchema(errorRef);
  if (!validateSuccess) {
    throw new Error(`buildClassifier: missing schema ${successRef}`);
  }
  if (!validateError) {
    throw new Error(`buildClassifier: missing schema ${errorRef}`);
  }

  return function classifyResponse(body: unknown): ResponseClass {
    // A string body is the raw handler output: parse it; unparseable -> malfunction.
    let value: unknown = body;
    if (typeof body === "string") {
      try {
        value = JSON.parse(body);
      } catch {
        return "malfunction";
      }
    }

    if (validateSuccess(value)) return "success";
    if (validateError(value)) return "declared_error";
    return "malfunction";
  };
}

/**
 * One-shot convenience: build a classifier from `openapi` and classify `body`.
 * For repeated calls prefer {@link buildClassifier} (compile once, reuse).
 */
export function classifyResponse(
  openapi: Record<string, unknown>,
  body: unknown,
): ResponseClass {
  return buildClassifier(openapi)(body);
}
