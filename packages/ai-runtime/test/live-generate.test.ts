// live-generate.test.ts - OPERATOR-GATED live model-generation smoke test.
//
// Proves the genuine supply-side loop end to end: a plain-English ResourceSpec ->
// the REAL ClaudeGenerator (Agent SDK, real ANTHROPIC_API_KEY, real network) -> a
// five-file bundle -> the SAME four 04-03 gates the platform runs -> pass. This is
// the one thing the autonomous suite by design never exercises (claude-backend.test
// constructs the generator but never invokes generate()).
//
// DOUBLE-GATED so the autonomous suite NEVER reaches a model/network path (the
// load-bearing selectGenerator invariant): it runs ONLY when BOTH UTTER_LIVE_GEN and
// ANTHROPIC_API_KEY are set. `pnpm test` with neither (the CI default) SKIPS it, so a
// developer with a key in .env.local still does not spend tokens on every run. Invoke
// explicitly, sourcing the key from .env.local (never echo it):
//   set -a; . ./.env.local; set +a; \
//   UTTER_LIVE_GEN=1 pnpm --filter @utter/ai-runtime exec vitest run test/live-generate.test.ts
//
// COST: one Agent SDK session on the cheapest model (Haiku unless DEFAULT_MODEL is
// already set) with a CONTRACT-ALIGNED echo prompt, so the model writes the canonical
// bundle in the fewest turns. The bundle-contract pins the {text}->{result,length}
// I/O shape (the G4 gate mounts exactly that), so an echo prompt yields a clean
// all-gate pass with minimal tokens. The point is to prove the LIVE generator + the
// gates, not novel handler logic (that is the operator-gated sandbox deferral).
//
// SECURITY: the key is read from the ambient env only (the runner sources .env.local)
// and is NEVER logged. Only the bundle the model authored + the gate verdicts print.
import { describe, it, expect } from "vitest";
import { selectGenerator } from "../src/generator.js";
import { validateBundle } from "../src/validate.js";
import { BUNDLE_KEYS, type ResourceSpec } from "../src/types.js";

// Double gate: an explicit opt-in flag AND a real key. Neither is set in CI, so the
// suite stays offline and green; both are set only when an operator invokes this file.
const LIVE = Boolean(process.env.UTTER_LIVE_GEN && process.env.ANTHROPIC_API_KEY);

// A contract-aligned echo spec. The prompt names the exact {text}->{result,length}
// contract the platform pins, so the model produces the canonical bundle deterministic-
// ally in minimal turns (cheapest real run). pricing.max is the USDC spend ceiling.
const SPEC: ResourceSpec = {
  prompt:
    'A text echo endpoint. Accept a JSON body { "text": <string> } and return ' +
    '{ "result": <the same text>, "length": <its character count> } with HTTP 200. ' +
    'Reject a non-string "text" with a 400 declared error { "error", "code" }. ' +
    "No upstreams; the resource is self-contained.",
  runtime: "node",
  pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
};

describe.skipIf(!LIVE)("live model generation (operator-gated)", () => {
  it(
    "a plain-English spec generates a real bundle that passes all four gates",
    async () => {
      // Force the cheapest model unless the operator pinned one. selectGenerator reads
      // env.DEFAULT_MODEL; pass a copy so we do not mutate the ambient process env.
      const env = {
        ...process.env,
        DEFAULT_MODEL: process.env.DEFAULT_MODEL ?? "claude-haiku-4-5-20251001",
      };
      const gen = selectGenerator(env);
      expect(gen.backend).toBe("claude");
      console.log(`[live-gen] backend=${gen.backend} model=${env.DEFAULT_MODEL}`);
      console.log(`[live-gen] prompt: ${SPEC.prompt}`);

      // THE live call: real Agent SDK loop, real model, real network.
      const bundle = await gen.generate(SPEC);

      // Surface the real model output (compact) so the run is observable.
      for (const key of BUNDLE_KEYS) {
        const body = bundle[key] ?? "";
        console.log(`\n===== ${key} (${body.length} bytes) =====\n${body.slice(0, 1400)}`);
      }

      // The same four gates the platform runs (in-process: G3 spec-only, G4 mock chain).
      const result = await validateBundle(bundle, SPEC);
      console.log(
        `\n[live-gen] gates  g1(shape)=${result.gates.g1.pass}  g2(static)=${result.gates.g2.pass}` +
          `  g3(build)=${result.gates.g3.pass}  g4(serve)=${result.gates.g4.pass}  =>  PASS=${result.pass}`,
      );
      if (!result.pass) {
        console.log("[live-gen] violations:\n" + JSON.stringify(result.violations, null, 2));
      }
      expect(result.pass).toBe(true);
    },
    180_000,
  );
});
