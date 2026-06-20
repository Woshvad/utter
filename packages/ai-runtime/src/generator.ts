// generator.ts - the Generator interface + selectGenerator(env) factory.
//
// This is the cross-phase pluggable-adapter-with-deterministic-test-default
// pattern (Phase 2 PaymentStore, Phase 3 SandboxRunner). The interface carries a
// `readonly backend` discriminator (mirroring SandboxRunner at
// services/sandbox/src/runner/types.ts:136-147); the env-driven selector returns
// the deterministic `scaffold` backend by default and the live `claude` backend
// only when ANTHROPIC_API_KEY is present and scaffold is not forced. The
// `!env.ANTHROPIC_API_KEY -> scaffold` branch is the load-bearing invariant: the
// whole autonomous suite runs green with no key and reaches no model/network path.
//
// Plan 04-02 replaces the placeholder bodies: the real ScaffoldGenerator lives in
// scaffold.ts (deterministic five-file bundle) and the real ClaudeGenerator lives
// in claude-backend.ts (operator-gated Agent SDK loop). This module owns the
// interface + the env-driven selector and re-exports the two concrete backends.
import type { Bundle, ResourceSpec } from "./types.js";
import { ScaffoldGenerator } from "./scaffold.js";
import { ClaudeGenerator, type ClaudeGeneratorConfig } from "./claude-backend.js";

export { ScaffoldGenerator } from "./scaffold.js";
export { ClaudeGenerator, type ClaudeGeneratorConfig } from "./claude-backend.js";

export interface Generator {
  /** Which backend this generator is - the deterministic-default discriminator. */
  readonly backend: "scaffold" | "claude";
  /** Turn a ResourceSpec into the five-file Bundle. */
  generate(spec: ResourceSpec): Promise<Bundle>;
}

/**
 * Env-driven backend selection. Defaults to scaffold whenever AI_RUNTIME_GENERATOR
 * is `scaffold` OR ANTHROPIC_API_KEY is absent - so the autonomous suite never
 * reaches a model/network path. Otherwise selects the claude backend with the
 * configured model (DEFAULT_MODEL or claude-sonnet-4-6). Constructing the claude
 * backend is lazy: no network call happens until generate() runs.
 */
export function selectGenerator(env: NodeJS.ProcessEnv = process.env): Generator {
  if (env.AI_RUNTIME_GENERATOR === "scaffold" || !env.ANTHROPIC_API_KEY) {
    return new ScaffoldGenerator();
  }
  return new ClaudeGenerator({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.DEFAULT_MODEL ?? "claude-sonnet-4-6",
  });
}
