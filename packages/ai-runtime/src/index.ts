// @utter/ai-runtime - the prompt-to-bundle generation member (SPEC §9.2).
//
// Public barrel. Re-exports the fixed contracts plan 04-02 (backends) and 04-03
// (validator) build against. The generate()/validateBundle() functions land in
// those later plans.
export type { Bundle, ResourceSpec, BundleKey } from "./types.js";
export { BUNDLE_KEYS } from "./types.js";
export type { Generator, ClaudeGeneratorConfig } from "./generator.js";
export { selectGenerator, ScaffoldGenerator, ClaudeGenerator } from "./generator.js";
