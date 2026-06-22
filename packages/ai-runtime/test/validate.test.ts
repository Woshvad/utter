// validate.test.ts (GEN-01/04) - the four-gate in-loop validator accepts the
// scaffold bundle through G1 (shape) + G2 (static) + G3 (build spec) + G4 (classify
// + serve-behind-x402), AUTONOMOUSLY: no ANTHROPIC_API_KEY, no live chain, no docker
// daemon, no forked chain. The scaffold bundle from generate(spec) is the guaranteed
// floor; this proves it passes every gate and that G4's 402 -> 200 money path holds
// against an in-process facilitator + a mock chain.
import { describe, it, expect } from "vitest";
import { ScaffoldGenerator } from "../src/scaffold.js";
import {
  validateBundle,
  gateShape,
  gateBuildSpec,
  gateServeBehindX402,
} from "../src/validate.js";
import { BUNDLE_KEYS } from "../src/types.js";
import type { Bundle, ResourceSpec } from "../src/types.js";

const spec: ResourceSpec = {
  prompt: "Echo the input text back with its length.",
  runtime: "node",
  pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
};

async function scaffoldBundle(): Promise<Bundle> {
  return new ScaffoldGenerator().generate(spec);
}

describe("validateBundle (GEN-01/04): four-gate acceptance over the scaffold bundle", () => {
  it("accepts the scaffold bundle with all four gates green (model-free, no live chain)", async () => {
    // The scaffold path is model-free BY CONSTRUCTION: scaffoldBundle() uses
    // ScaffoldGenerator directly (never selectGenerator), so it makes no model call
    // regardless of the ambient ANTHROPIC_API_KEY. We deliberately do NOT assert on the
    // env here - that was brittle (a developer with a real key in .env.local, which the
    // packages/chain live-RPC test loads into process.env, would fail it) and asserted
    // environment state rather than code behavior. The no-model-path invariant is owned
    // by selectGenerator (generator.test.ts), not this gate-acceptance test.
    const bundle = await scaffoldBundle();
    const result = await validateBundle(bundle, spec);
    if (!result.pass) {
      // Surface the failing violations to make a regression legible.
      throw new Error(`validateBundle failed: ${JSON.stringify(result.violations, null, 2)}`);
    }
    expect(result.pass).toBe(true);
    expect(result.gates.g1.pass).toBe(true);
    expect(result.gates.g2.pass).toBe(true);
    expect(result.gates.g3.pass).toBe(true);
    expect(result.gates.g4.pass).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("G1 fails when a BUNDLE_KEYS file is missing", async () => {
    const bundle = await scaffoldBundle();
    delete bundle["agent-card.json"];
    const { result } = gateShape(bundle);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.gate === "g1" && v.file === "agent-card.json")).toBe(
      true,
    );
  });

  it("G1 fails when openapi.json does not parse", async () => {
    const bundle = await scaffoldBundle();
    bundle["openapi.json"] = "{ not valid json";
    const { result } = gateShape(bundle);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.gate === "g1" && v.kind === "openapi-invalid")).toBe(
      true,
    );
  });

  it("G1 fails LOUDLY when openapi declares more than one *Success/*Error schema (IN-02)", async () => {
    // A model-authored openapi with two *Success schemas must not silently pick one
    // by object-key order; the gate must reject it as ambiguous (deterministic).
    const bundle = await scaffoldBundle();
    const doc = JSON.parse(bundle["openapi.json"]!);
    doc.components.schemas.AltSuccess = doc.components.schemas.ResourceSuccess;
    bundle["openapi.json"] = JSON.stringify(doc, null, 2);
    const { result } = gateShape(bundle);
    expect(result.pass).toBe(false);
    expect(
      result.violations.some(
        (v) => v.gate === "g1" && v.kind === "openapi-schema-ambiguous",
      ),
    ).toBe(true);
  });

  it("G1 fails when the agent-card is the rejected A2A v1.0.0 supportedInterfaces shape", async () => {
    const bundle = await scaffoldBundle();
    bundle["agent-card.json"] = JSON.stringify({
      supportedInterfaces: [{ transport: "JSONRPC", url: "https://x.example" }],
      name: "x",
    });
    const { result } = gateShape(bundle);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.gate === "g1" && v.kind === "agent-card-invalid")).toBe(
      true,
    );
  });

  it("G3 produces a digest-pinned, spec-only build (built:false, operator-gated isolation)", async () => {
    const bundle = await scaffoldBundle();
    const { result, buildSpec } = await gateBuildSpec(bundle, spec, "resource:test");
    expect(result.pass).toBe(true);
    expect(buildSpec?.built).toBe(false);
    expect(buildSpec?.baseImage).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(buildSpec?.lockfile).toBe("pnpm-lock.yaml");
    expect(buildSpec?.networkIsolation).toBe("operator-gated");
    expect(buildSpec?.dockerfile).toMatch(/^FROM /m);
  });

  it("G4 fails when a test-cases case classifies to the WRONG class (negative control)", async () => {
    const bundle = await scaffoldBundle();
    const { openapi, testCases } = gateShape(bundle);
    expect(openapi).toBeDefined();
    expect(testCases).toBeDefined();
    // Mutate the success case's expectedClass so it no longer matches the classifier.
    const wrong = testCases!.map((c) =>
      c.expectedClass === "success" ? { ...c, expectedClass: "malfunction" as const } : c,
    );
    const g4 = await gateServeBehindX402(openapi!, wrong, spec);
    expect(g4.pass).toBe(false);
    expect(g4.violations.some((v) => v.gate === "g4" && v.kind === "misclassified")).toBe(true);
  });

  it("the validator exercises exactly the five BUNDLE_KEYS (no extra file is required)", async () => {
    const bundle = await scaffoldBundle();
    expect(Object.keys(bundle).sort()).toEqual([...BUNDLE_KEYS].sort());
  });
});
