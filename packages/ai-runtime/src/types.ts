// types.ts - the fixed data contracts every later Phase 4 task builds against
// (GEN-01/03). Mirrors the SandboxRunner/RunSpec literal-field discipline
// (services/sandbox/src/runner/types.ts): security-relevant fields constrained to
// literals so invariants are unit-assertable with no live call.

// Re-export Bundle from @utter/sandbox - never redefine it. The bundle that flows
// into runPrePublishStaticChecks (the GEN-02 static gate) MUST be the same nominal
// type the gate consumes (services/sandbox/src/prepublish/secret-scan.ts:16).
export type { Bundle } from "@utter/sandbox";

/**
 * The input contract for a generation request: a plain-English prompt plus the
 * structured hints the backends need (runtime picks the pinned base image, pricing
 * feeds the agent-card x402 block, upstreams are the allowlisted hosts reached via
 * the data-proxy).
 */
export interface ResourceSpec {
  prompt: string;
  runtime: "node" | "python";
  pricing: { model: "metered"; base: string; perKB: string; max: string };
  upstreams?: string[];
}

/**
 * The five bundle file keys, as literal POSIX strings, in order. Declared
 * `as const` and hard-coded (never derived from path.join) so a Windows backslash
 * can never enter a bundle key (RESEARCH Pitfall 3). The build context and the
 * static scans key on these exact strings.
 */
export const BUNDLE_KEYS = [
  "handler.ts",
  "Dockerfile",
  "openapi.json",
  "agent-card.json",
  "test-cases.json",
] as const;

/** A bundle file key - one of the five literal POSIX strings in BUNDLE_KEYS. */
export type BundleKey = (typeof BUNDLE_KEYS)[number];
