// runPrePublishStaticChecks - the combined autonomous pre-publish gate
// (SBX-06a + SBX-06b).
//
// ANDs the two static scans (secret scan + dangerous-import AST) over a bundle.
// ANY violation FAILS publication (RESEARCH Pattern 6: a violation fails the
// gate). The dynamic blocked-host probe (SBX-06c) is NOT part of this function -
// it is operator-gated (probe.ts) and runs on the provisioned host in Plan 06.
import { scanImports, type ImportViolation } from "./import-scan";
import { scanSecrets, type Bundle, type SecretViolation } from "./secret-scan";

/** A single combined-gate violation (a secret finding or an import finding). */
export type PrePublishViolation =
  | ({ kind: "secret" } & SecretViolation)
  | ({ kind: "import"; file: string } & ImportViolation);

/** The combined gate result. `pass:false` blocks publication. */
export interface PrePublishResult {
  /** True only when BOTH scans are clean. */
  pass: boolean;
  /** Every violation found (empty when pass). */
  violations: PrePublishViolation[];
}

/**
 * Run the autonomous static pre-publish checks over a bundle. Returns
 * `{ pass:false, violations:[...] }` if the secret scan OR the import scan finds
 * anything, else `{ pass:true, violations:[] }`.
 */
export function runPrePublishStaticChecks(bundle: Bundle): PrePublishResult {
  const violations: PrePublishViolation[] = [];

  // (a) Secret scan over the whole bundle.
  for (const v of scanSecrets(bundle)) {
    violations.push({ kind: "secret", ...v });
  }

  // (b) Dangerous-import / dangerous-API AST scan, per file.
  for (const [file, source] of Object.entries(bundle)) {
    for (const v of scanImports(source, file)) {
      violations.push({ kind: "import", file, ...v });
    }
  }

  return { pass: violations.length === 0, violations };
}
