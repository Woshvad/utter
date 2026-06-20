// Echo openapi.json AJV compile + classification suite (PAY-04, Pattern 5; A3).
// Proves the echo schemas compile under AJV `strict:false` + ajv-formats (the
// OpenAPI dialect baseline) and that the gate's classify primitives work: a
// success body validates against EchoSuccess, a declared-error body validates
// against EchoError, and a malformed body validates against neither (malfunction).
// Offline unit test - no env, no RPC.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const openapi = JSON.parse(
  readFileSync(here("../examples/echo/openapi.json"), "utf8"),
) as Record<string, unknown>;
const testCases = JSON.parse(
  readFileSync(here("../examples/echo/test-cases.json"), "utf8"),
) as { cases: { label: string; response: unknown; expectedClass: string }[] };

let validateSuccess: ValidateFunction;
let validateError: ValidateFunction;

function classify(body: unknown): "success" | "declared_error" | "malfunction" {
  if (validateSuccess(body)) return "success";
  if (validateError(body)) return "declared_error";
  return "malfunction";
}

describe("echo openapi.json AJV compilation", () => {
  beforeAll(() => {
    // strict:false tolerates the OpenAPI dialect; addFormats supplies date-time/uri/etc.
    const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
    ajv.addSchema(openapi);
    const success = ajv.getSchema("openapi.json#/components/schemas/EchoSuccess");
    const error = ajv.getSchema("openapi.json#/components/schemas/EchoError");
    expect(success, "EchoSuccess schema failed to compile").toBeDefined();
    expect(error, "EchoError schema failed to compile").toBeDefined();
    validateSuccess = success!;
    validateError = error!;
  });

  it("compiles both EchoSuccess and EchoError schemas", () => {
    expect(typeof validateSuccess).toBe("function");
    expect(typeof validateError).toBe("function");
  });

  it("validates a success body and rejects a malformed one", () => {
    expect(validateSuccess({ echo: "hello", length: 5 })).toBe(true);
    expect(validateSuccess({ unexpected: "field", length: "not-an-integer" })).toBe(false);
  });

  it("classifies each fixture to its expected class", () => {
    for (const c of testCases.cases) {
      expect(classify(c.response), `fixture "${c.label}" misclassified`).toBe(
        c.expectedClass,
      );
    }
  });
});
