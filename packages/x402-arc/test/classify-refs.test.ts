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

// A scaffold-shaped openapi using ResourceSuccess/ResourceError EXACTLY as
// scaffold.ts buildOpenapi emits (object, additionalProperties false, success
// required [result, length] with result:string and length:integer minimum 0,
// error required [error] with error:string + optional code:string). No Echo*
// schemas, no explicit refs: this is the live studio->deployer bundle shape that
// buildClassifier previously threw on.
const scaffoldOpenapi: Record<string, unknown> = {
  $id: "openapi.json",
  openapi: "3.1.0",
  info: { title: "Resource", version: "1.0.0" },
  paths: {},
  components: {
    schemas: {
      ResourceSuccess: {
        type: "object",
        additionalProperties: false,
        required: ["result", "length"],
        properties: {
          result: { type: "string" },
          length: { type: "integer", minimum: 0 },
        },
      },
      ResourceError: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: { error: { type: "string" }, code: { type: "string" } },
      },
    },
  },
};

describe("buildClassifier suffix discovery with no opts (GEN-04 / the fix)", () => {
  it("builds WITHOUT throwing on a scaffold-shaped openapi (the regression)", () => {
    expect(() => buildClassifier(scaffoldOpenapi)).not.toThrow();
  });

  describe("scaffold-shaped ResourceSuccess/ResourceError, no opts", () => {
    const classify = buildClassifier(scaffoldOpenapi);

    it("classifies { result, length } as success", () => {
      expect(classify({ result: "hi", length: 2 })).toBe("success");
    });

    it("classifies { error, code } as declared_error", () => {
      expect(classify({ error: "bad", code: "X" })).toBe("declared_error");
    });

    it("classifies a missing-field body (no length) as malfunction", () => {
      expect(classify({ result: "hi" })).toBe("malfunction");
    });

    it("classifies an off-shape body as malfunction", () => {
      expect(classify({ foo: 1 })).toBe("malfunction");
    });
  });

  describe("a generic <Name>Success/<Name>Error openapi, no opts", () => {
    // Reuse the existing weatherOpenapi but discover the refs instead of passing them.
    const classify = buildClassifier(weatherOpenapi);

    it("discovers WeatherSuccess and classifies a matching body as success", () => {
      expect(classify({ tempC: 21.5, city: "Harare" })).toBe("success");
    });

    it("discovers WeatherError and classifies { error, code } as declared_error", () => {
      expect(classify({ error: "unknown city", code: "BAD_CITY" })).toBe("declared_error");
    });
  });

  // Explicit { successRef, errorRef } still win over discovery: the first describe
  // block above (buildClassifier(weatherOpenapi, { successRef, errorRef })) already
  // proves the explicit-override path stays green; this note records the coverage.
});

describe("buildClassifier fails closed on ambiguity or absence", () => {
  it("throws when TWO *Success schemas exist and there is no EchoSuccess", () => {
    // Ambiguous discovery returns undefined -> Echo default ref -> absent -> throw.
    const ambiguous: Record<string, unknown> = {
      $id: "openapi.json",
      openapi: "3.1.0",
      info: { title: "Ambiguous", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          AlphaSuccess: { type: "object", properties: { a: { type: "string" } } },
          BetaSuccess: { type: "object", properties: { b: { type: "string" } } },
          OnlyError: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    };
    expect(() => buildClassifier(ambiguous)).toThrow(/missing schema/);
  });

  it("throws when there is NEITHER a *Success nor an EchoSuccess", () => {
    // No suffix match and no echo default present -> the existing throw fires.
    const none: Record<string, unknown> = {
      $id: "openapi.json",
      openapi: "3.1.0",
      info: { title: "None", version: "1.0.0" },
      paths: {},
      components: { schemas: { Plain: { type: "object" } } },
    };
    expect(() => buildClassifier(none)).toThrow(/missing schema/);
  });
});
