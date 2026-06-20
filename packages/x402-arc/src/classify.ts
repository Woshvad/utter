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
 * Compile an openapi doc into a classifier. By default the doc must define
 * `components.schemas.EchoSuccess` and `EchoError` and carry `$id:"openapi.json"`
 * (Wave 0 echo fixture sets it). Pass `{ successRef, errorRef }` to classify
 * against resource-named component schemas instead (Phase 4 generated openapi),
 * e.g. `openapi.json#/components/schemas/WeatherSuccess`. Throws at build time if
 * either schema is absent so a misconfigured resource fails loudly rather than
 * silently classifying everything as malfunction.
 */
export function buildClassifier(
  openapi: Record<string, unknown>,
  opts?: ClassifierRefs,
): ClassifyResponse {
  const successRef = opts?.successRef ?? SUCCESS_REF;
  const errorRef = opts?.errorRef ?? ERROR_REF;
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
