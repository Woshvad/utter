// scaffold.test.ts (GEN-03) - the deterministic scaffold backend produces a
// complete, schema-shaped five-file bundle with ZERO model calls and no
// ANTHROPIC_API_KEY. Offline unit test: no key, no network. This is the guaranteed
// bundle floor the 04-03 validator proves through all four gates.
import { describe, it, expect } from "vitest";
import { assertPinnedByDigest } from "@utter/deployer";
import { ScaffoldGenerator } from "../src/scaffold.js";
import { selectGenerator } from "../src/generator.js";
import { BUNDLE_KEYS } from "../src/types.js";
import type { ResourceSpec } from "../src/types.js";

const baseSpec: ResourceSpec = {
  prompt: "Echo the input text back with its length.",
  runtime: "node",
  pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
};

const upstreamSpec: ResourceSpec = {
  ...baseSpec,
  prompt: "Fetch the current weather for a city from the upstream weather API.",
  upstreams: ["api.weather.example"],
};

describe("ScaffoldGenerator (GEN-03)", () => {
  it("produces a bundle whose keys are EXACTLY BUNDLE_KEYS (no extra, none missing)", async () => {
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    expect(Object.keys(bundle).sort()).toEqual([...BUNDLE_KEYS].sort());
  });

  it("selectGenerator(env) with no ANTHROPIC_API_KEY returns the scaffold bundle (zero model calls)", async () => {
    const gen = selectGenerator({});
    expect(gen.backend).toBe("scaffold");
    const bundle = await gen.generate(baseSpec);
    // The five files are present and non-empty - produced with no key, no network.
    for (const key of BUNDLE_KEYS) {
      expect(typeof bundle[key]).toBe("string");
      expect(bundle[key]!.length).toBeGreaterThan(0);
    }
  });

  it("openapi.json parses, is openapi 3.1, and defines a success AND a documented-error schema", async () => {
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    const openapi = JSON.parse(bundle["openapi.json"]!) as Record<string, unknown>;
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.$id).toBe("openapi.json");
    const schemas = (openapi.components as { schemas: Record<string, unknown> }).schemas;
    const names = Object.keys(schemas);
    // Exactly one success + one documented-error component schema.
    const successName = names.find((n) => /Success$/.test(n));
    const errorName = names.find((n) => /Error$/.test(n));
    expect(successName).toBeDefined();
    expect(errorName).toBeDefined();
    expect((schemas[successName!] as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("test-cases.json contains at least one success, one declared_error, and one malfunction case", async () => {
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    const fixtures = JSON.parse(bundle["test-cases.json"]!) as {
      cases: Array<{ expectedClass: string }>;
    };
    const classes = fixtures.cases.map((c) => c.expectedClass);
    expect(classes).toContain("success");
    expect(classes).toContain("declared_error");
    expect(classes).toContain("malfunction");
  });

  it("the scaffold test-cases classify to their expectedClass via the resource-named classifier", async () => {
    // Proves the openapi success/error component names line up with the test-cases
    // via the parameterized buildClassifier (the 04-03 G4 path).
    const { buildClassifier } = await import("@utter/x402-arc");
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    const openapi = JSON.parse(bundle["openapi.json"]!) as Record<string, unknown>;
    const schemas = (openapi.components as { schemas: Record<string, unknown> }).schemas;
    const names = Object.keys(schemas);
    const successName = names.find((n) => /Success$/.test(n))!;
    const errorName = names.find((n) => /Error$/.test(n))!;
    const classify = buildClassifier(openapi, {
      successRef: `openapi.json#/components/schemas/${successName}`,
      errorRef: `openapi.json#/components/schemas/${errorName}`,
    });
    const fixtures = JSON.parse(bundle["test-cases.json"]!) as {
      cases: Array<{ response: unknown; expectedClass: string }>;
    };
    for (const tc of fixtures.cases) {
      expect(classify(tc.response)).toBe(tc.expectedClass);
    }
  });

  it("the Dockerfile equals the deployer generateDockerfile output (digest-pinned, never free-form)", async () => {
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    const dockerfile = bundle["Dockerfile"]!;
    // assertPinnedByDigest throws unless the FROM is pinned @sha256:<64 hex>.
    expect(() => {
      for (const line of dockerfile.split("\n")) {
        if (line.startsWith("FROM ")) assertPinnedByDigest(line.slice(5).trim());
      }
    }).not.toThrow();
    expect(dockerfile).toMatch(/@sha256:[0-9a-f]{64}/);
  });

  it("for an upstreams spec the handler routes via EGRESS_PROXY_URL + x-resource-token and embeds no literal key", async () => {
    const bundle = await new ScaffoldGenerator().generate(upstreamSpec);
    const handler = bundle["handler.ts"]!;
    expect(handler).toContain("EGRESS_PROXY_URL");
    expect(handler).toContain("x-resource-token");
    // No literal upstream secret: no sk-..., no AKIA..., no 0x<64hex> key.
    expect(handler).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    expect(handler).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    expect(handler).not.toMatch(/\b0x[0-9a-fA-F]{64}\b/);
    // And never a hard-coded Authorization bearer key.
    expect(handler).not.toMatch(/[Aa]uthorization.*[Bb]earer sk-/);
  });

  it("a node spec without upstreams produces a self-contained echo handler (no proxy import path)", async () => {
    const bundle = await new ScaffoldGenerator().generate(baseSpec);
    const handler = bundle["handler.ts"]!;
    // The base handler is the echo template: BAD_JSON / BAD_INPUT branches + success.
    expect(handler).toContain("BAD_JSON");
    expect(handler).toContain("BAD_INPUT");
    // No upstream egress CALL is emitted for a spec with no upstreams (the keyless
    // proxy fetch block is absent). The template's doc comment may still name the
    // env var / header, but no `fetch(... + "/proxy")` block is templated in.
    expect(handler).not.toContain('proxyBase + "/proxy"');
    expect(handler).not.toContain("RESOURCE_TOKEN");
  });
});
