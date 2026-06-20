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

/**
 * Compile an openapi doc into a classifier. The doc must define
 * `components.schemas.EchoSuccess` and `EchoError` and carry `$id:"openapi.json"`
 * (Wave 0 echo fixture sets it). Throws at build time if either schema is absent
 * so a misconfigured resource fails loudly rather than silently classifying
 * everything as malfunction.
 */
export function buildClassifier(openapi: Record<string, unknown>): ClassifyResponse {
  // strict:false tolerates the OpenAPI 3.1 dialect; addFormats supplies
  // date-time/uri/email/etc. AJV would otherwise omit.
  const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
  if (openapi.$id === undefined) {
    openapi.$id = "openapi.json";
  }
  ajv.addSchema(openapi);

  const validateSuccess: ValidateFunction | undefined = ajv.getSchema(SUCCESS_REF);
  const validateError: ValidateFunction | undefined = ajv.getSchema(ERROR_REF);
  if (!validateSuccess) {
    throw new Error(`buildClassifier: missing schema ${SUCCESS_REF}`);
  }
  if (!validateError) {
    throw new Error(`buildClassifier: missing schema ${ERROR_REF}`);
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
