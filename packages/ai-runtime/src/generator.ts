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
// In THIS plan (04-01) the two backend bodies are placeholders - their `generate`
// throws `not-implemented`. Plan 04-02 replaces the bodies; the `backend`
// discriminator and the selector are fully testable now.
import type { Bundle, ResourceSpec } from "./types.js";

export interface Generator {
  /** Which backend this generator is - the deterministic-default discriminator. */
  readonly backend: "scaffold" | "claude";
  /** Turn a ResourceSpec into the five-file Bundle. */
  generate(spec: ResourceSpec): Promise<Bundle>;
}

/** Config for the operator-gated claude backend. */
export interface ClaudeGeneratorConfig {
  apiKey: string;
  model: string;
}

/**
 * The deterministic, zero-model-call backend - the test default. Templated from
 * the proven echo bundle in plan 04-02. Placeholder body here so the selector +
 * its discriminator are testable in 04-01.
 */
export class ScaffoldGenerator implements Generator {
  readonly backend = "scaffold" as const;

  async generate(_spec: ResourceSpec): Promise<Bundle> {
    throw new Error("ScaffoldGenerator.generate not-implemented (lands in plan 04-02)");
  }
}

/**
 * The live, operator-gated backend driven by @anthropic-ai/claude-agent-sdk.
 * Needs ANTHROPIC_API_KEY + network and is never the CI default. Constructing it
 * performs NO network call (the model is contacted only inside generate()), so the
 * selector can return it from env alone without a live key beyond the flag.
 * Placeholder body here; the agent-loop wiring lands in plan 04-02.
 */
export class ClaudeGenerator implements Generator {
  readonly backend = "claude" as const;
  private readonly config: ClaudeGeneratorConfig;

  constructor(config: ClaudeGeneratorConfig) {
    // Store config only - do NOT touch the network here.
    this.config = config;
  }

  async generate(_spec: ResourceSpec): Promise<Bundle> {
    throw new Error("ClaudeGenerator.generate not-implemented (lands in plan 04-02)");
  }
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
