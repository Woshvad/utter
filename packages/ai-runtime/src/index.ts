// @utter/ai-runtime - the prompt-to-bundle generation member (SPEC §9.2).
//
// Public barrel. Re-exports the fixed contracts + the two backends + the public
// generate() entry. The 04-03 validator (validateBundle) lands in the next plan.
import type { Bundle, ResourceSpec } from "./types.js";
import { selectGenerator } from "./generator.js";

export type { Bundle, ResourceSpec, BundleKey } from "./types.js";
export { BUNDLE_KEYS } from "./types.js";
export type { Generator, ClaudeGeneratorConfig } from "./generator.js";
export { selectGenerator, ScaffoldGenerator, ClaudeGenerator } from "./generator.js";
export { buildAgentCard, validateAgentCard, A2A_PROTOCOL_VERSION } from "./agent-card.js";
export type { AgentCardValidationResult } from "./agent-card.js";

// The four-gate in-loop validator (GEN-01/02/04): every generated Bundle passes
// validateBundle before the Phase 3 deploy hand-off. The four gates are also
// exported individually so a caller can run a subset.
export {
  validateBundle,
  gateShape,
  gateStatic,
  gateBuildSpec,
  gateServeBehindX402,
} from "./validate.js";
export type {
  ValidationResult,
  ValidationViolation,
  GateResult,
  GateId,
  ValidateBundleOpts,
} from "./validate.js";

/**
 * The public generation entry: select the backend from `env` (scaffold by default,
 * the operator-gated claude backend only when ANTHROPIC_API_KEY is present and
 * scaffold is not forced) and produce the five-file Bundle. The autonomous suite
 * runs the scaffold path with no key and no network.
 */
export function generate(
  spec: ResourceSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Bundle> {
  return selectGenerator(env).generate(spec);
}
