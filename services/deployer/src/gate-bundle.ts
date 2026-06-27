// gate-bundle.ts - the PRE-BUILD fail-closed static gate for GENERATED (untrusted)
// bundles (deploy plane B).
//
// SECURITY: the bundle's handler.ts is UNTRUSTED generated code. gateGeneratedBundle
// runs the @utter/sandbox prepublish static checks (secret scan + dangerous-import AST)
// over the IN-MEMORY bundle and THROWS a typed BundleGateError on ANY violation. It MUST
// be called BEFORE bundleGeneratedHandler / buildResourceImage, so a malicious bundle is
// rejected before any esbuild/build produces an artifact.
//
// FAIL CLOSED: if the static check itself throws (e.g. a TS parse error inside the
// scan), we CATCH it and re-throw as a BundleGateError - an erroring gate must block
// publication, never silently pass. Any ambiguity blocks: this is untrusted-code
// handling.
//
// We reuse the @utter/sandbox gate (an existing deployer dependency, no cycle) rather
// than re-implementing the scans, and do NOT import @utter/ai-runtime.
import {
  runPrePublishStaticChecks,
  type Bundle,
  type PrePublishViolation,
  type PrePublishResult,
} from "@utter/sandbox";
// Self-namespace import so gateGeneratedBundle calls runStaticChecksForGate through the
// module binding. That single indirection is what lets the fail-closed test stub the
// static check to throw and assert the gate still blocks (never passes).
import * as gateSelf from "./gate-bundle";

/**
 * A typed error thrown when a generated bundle fails (or cannot complete) the pre-build
 * static gate. It carries the violation list (and the original error as `cause` when the
 * static check ITSELF errored) and a message that names the violations. It never includes
 * a raw secret value: the underlying gate already redacts secret previews.
 */
export class BundleGateError extends Error {
  /** Every violation the static gate found (empty when the check itself errored). */
  readonly violations: PrePublishViolation[];

  constructor(violations: PrePublishViolation[], options?: { cause?: unknown }) {
    super(BundleGateError.describe(violations, options?.cause));
    this.name = "BundleGateError";
    this.violations = violations;
    if (options?.cause !== undefined) {
      // Preserve the original error for diagnostics (fail-closed path).
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** Build an actionable message naming the violations (or the fail-closed reason). */
  private static describe(violations: PrePublishViolation[], cause?: unknown): string {
    if (violations.length === 0) {
      const reason = cause instanceof Error ? cause.message : String(cause ?? "unknown");
      return `pre-build gate failed closed: the static check could not complete (${reason})`;
    }
    const rules = violations.map((v) => v.rule);
    const head = rules.slice(0, 5).join(", ");
    const more = rules.length > 5 ? ` (+${rules.length - 5} more)` : "";
    return `pre-build gate rejected the bundle: ${violations.length} violation(s): ${head}${more}`;
  }
}

/**
 * Indirection over runPrePublishStaticChecks so it is callable through this module's
 * namespace. This is the single place the gate runs the @utter/sandbox checks; calling it
 * via the module export lets the fail-closed test stub it to throw, exercising the catch.
 */
export function runStaticChecksForGate(bundle: Bundle): PrePublishResult {
  return runPrePublishStaticChecks(bundle);
}

/**
 * Run the pre-build static gate over a generated bundle. On a clean pass it returns
 * silently. On ANY violation it throws a BundleGateError naming the violations. If the
 * static check ITSELF throws, it FAILS CLOSED: catch and re-throw as a BundleGateError
 * (never swallow it and continue). This MUST run BEFORE bundleGeneratedHandler /
 * buildResourceImage, over the in-memory bundle, before any artifact is produced.
 */
export function gateGeneratedBundle(bundle: Bundle): void {
  let result: PrePublishResult;
  try {
    // Call via the module namespace so the fail-closed test can stub it to throw.
    result = gateSelf.runStaticChecksForGate(bundle);
  } catch (err) {
    // FAIL CLOSED: an erroring static check blocks publication, never passes.
    throw new BundleGateError([], { cause: err });
  }

  if (!result.pass) {
    throw new BundleGateError(result.violations);
  }
}
