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

  // (a) Secret scan. Declarative JSON artifacts (openapi.json / agent-card.json /
  // test-cases.json) legitimately carry PUBLIC high-entropy constants - the payTo /
  // resourceId / USDC addresses - which the generic Shannon-entropy pass would
  // false-positive on (every generated bundle would otherwise fail the gate on the
  // agent-card payTo address). Scan those with the NAMED provider rules only (entropy
  // off); a real embedded key (sk-/AKIA/gh_/slack/0x<64hex> private key/api-key=...)
  // is still caught there. The executable + config files (handler.ts, Dockerfile) get
  // the FULL scan including the entropy pass, since untrusted code is the real
  // secret-exfil surface. This mirrors the scanSecrets({ entropy:false }) contract and
  // the runner's KNOWN_PUBLIC_CONSTANT allowance for the same public on-chain values.
  const codeBundle: Bundle = {};
  const declarativeBundle: Bundle = {};
  for (const [file, source] of Object.entries(bundle)) {
    if (file.endsWith(".json")) declarativeBundle[file] = source;
    else codeBundle[file] = source;
  }
  for (const v of scanSecrets(codeBundle)) {
    violations.push({ kind: "secret", ...v });
  }
  for (const v of scanSecrets(declarativeBundle, { entropy: false })) {
    violations.push({ kind: "secret", ...v });
  }

  // (b) Dangerous-import / dangerous-API AST scan, per file (over the whole bundle).
  for (const [file, source] of Object.entries(bundle)) {
    for (const v of scanImports(source, file)) {
      violations.push({ kind: "import", file, ...v });
    }
  }

  return { pass: violations.length === 0, violations };
}
