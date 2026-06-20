// Parameterized buildClassifier suite (GEN-04 prep). Proves the additive
// { successRef, errorRef } option classifies a resource-named openapi correctly,
// while the default-arg path is byte-for-byte unchanged (still classifies the
// shared echo fixture). Offline unit test - no env.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildClassifier } from "../src/classify";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const echoOpenapi = JSON.parse(
  readFileSync(here("../examples/echo/openapi.json"), "utf8"),
) as Record<string, unknown>;

// A resource-named openapi using Weather* schemas instead of Echo*.
const weatherOpenapi: Record<string, unknown> = {
  $id: "openapi.json",
  openapi: "3.1.0",
  info: { title: "Weather", version: "1.0.0" },
  paths: {
    "/": {
      post: {
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WeatherSuccess" },
              },
            },
          },
          "400": {
            description: "Declared error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WeatherError" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      WeatherSuccess: {
        type: "object",
        additionalProperties: false,
        required: ["tempC", "city"],
        properties: { tempC: { type: "number" }, city: { type: "string" } },
      },
      WeatherError: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: { error: { type: "string" }, code: { type: "string" } },
      },
    },
  },
};

describe("buildClassifier with resource-named refs (GEN-04)", () => {
  const classify = buildClassifier(weatherOpenapi, {
    successRef: "openapi.json#/components/schemas/WeatherSuccess",
    errorRef: "openapi.json#/components/schemas/WeatherError",
  });

  it("classifies a matching success body as success", () => {
    expect(classify({ tempC: 21.5, city: "Harare" })).toBe("success");
  });

  it("classifies a matching declared-error body as declared_error", () => {
    expect(classify({ error: "unknown city", code: "BAD_CITY" })).toBe("declared_error");
  });

  it("classifies a body matching neither resource schema as malfunction", () => {
    expect(classify({ unexpected: "field" })).toBe("malfunction");
  });

  it("throws loudly when a supplied ref is absent", () => {
    expect(() =>
      buildClassifier(weatherOpenapi, {
        successRef: "openapi.json#/components/schemas/DoesNotExist",
      }),
    ).toThrow(/missing schema/);
  });
});

describe("buildClassifier default path is unchanged (no regression)", () => {
  const classify = buildClassifier(echoOpenapi);

  it("still classifies the echo success body via the default Echo* refs", () => {
    expect(classify({ echo: "hello", length: 5 })).toBe("success");
  });

  it("still classifies the echo declared-error body via the default Echo* refs", () => {
    expect(classify({ error: "text must be a string", code: "BAD_INPUT" })).toBe(
      "declared_error",
    );
  });
});
