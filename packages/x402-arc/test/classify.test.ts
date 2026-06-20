// AJV response classifier suite (PAY-06; Pattern 5). buildClassifier(openapi)
// returns classifyResponse(body) -> success | declared_error | malfunction by
// validating against the echo openapi.json EchoSuccess + EchoError schemas. The
// declared_error vs malfunction distinction is what stops a buyer's bad input
// from wrongfully striking the creator. Driven by the shared echo fixtures.
// Offline unit test - no env.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildClassifier } from "../src/classify";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const openapi = JSON.parse(
  readFileSync(here("../examples/echo/openapi.json"), "utf8"),
) as Record<string, unknown>;
const fixtures = JSON.parse(
  readFileSync(here("../examples/echo/test-cases.json"), "utf8"),
) as { cases: { label: string; response: unknown; expectedClass: string }[] };

const classifyResponse = buildClassifier(openapi);

describe("classify response against echo openapi.json (PAY-06)", () => {
  it("classifies a valid success body as success", () => {
    expect(classifyResponse({ echo: "hello", length: 5 })).toBe("success");
  });

  it("classifies a valid declared-error body as declared_error", () => {
    expect(
      classifyResponse({ error: "text must be a string", code: "BAD_INPUT" }),
    ).toBe("declared_error");
  });

  it("classifies a body matching neither schema as malfunction", () => {
    expect(
      classifyResponse({ unexpected: "field", length: "not-an-integer" }),
    ).toBe("malfunction");
  });

  it("classifies a non-JSON string body as malfunction", () => {
    expect(classifyResponse("this is not json")).toBe("malfunction");
  });

  it("classifies each shared echo fixture to its expected class", () => {
    for (const c of fixtures.cases) {
      expect(classifyResponse(c.response), `fixture "${c.label}" misclassified`).toBe(
        c.expectedClass,
      );
    }
  });
});
