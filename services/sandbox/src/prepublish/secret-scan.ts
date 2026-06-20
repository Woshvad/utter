// scanSecrets - the static secret scan (SBX-06a; RESEARCH Pattern 6).
//
// The gitleaks model: a regex rule-set first (named provider patterns), then a
// Shannon-entropy secondary pass over high-randomness string literals to catch
// generic high-entropy secrets the named rules miss. Pure + synchronous; reads
// the bundle's source text only, never executes it. A finding FAILS publication
// (combined with scanImports in runPrePublishStaticChecks).
//
// NOTE: this is a from-scratch, dependency-free scanner (entropy + a focused
// rule-set) because `@utter/sandbox` does not depend on the secretlint engine
// (it lives in the deployer member). The prod pipeline may additionally shell to
// gitleaks/secretlint on the provisioned host for ruleset depth; the autonomous
// gate here is the entropy + named-pattern pass.

/** A bundle to scan: a map of relative file path -> source text. */
export type Bundle = Record<string, string>;

/** A single secret-scan finding. */
export interface SecretViolation {
  /** The rule that fired (a named provider pattern, or the entropy heuristic). */
  rule: string;
  /** The file the secret was found in. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** A redacted preview of the match (never the full secret). */
  preview: string;
}

/** Named-provider regex rules (rule-first pass). */
const SECRET_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "generic-api-key-assignment", pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9+/_\-]{16,}["']/i },
  { rule: "hex-private-key", pattern: /\b0x[a-fA-F0-9]{64}\b/ },
];

/** Shannon entropy (bits/char) of a string. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Entropy threshold (bits/char) above which a long token is suspicious. */
const ENTROPY_THRESHOLD = 4.0;
/** Minimum length for the entropy pass to consider a token (short strings are noisy). */
const ENTROPY_MIN_LEN = 20;

/** Pull candidate high-entropy tokens (quoted strings + bare long tokens) from a line. */
function entropyCandidates(line: string): string[] {
  const out: string[] = [];
  // Quoted string literals.
  for (const m of line.matchAll(/["'`]([A-Za-z0-9+/_\-=]{20,})["'`]/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Redact a matched secret to a short, safe preview. */
function redact(match: string): string {
  if (match.length <= 8) return "****";
  return `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`;
}

/**
 * Scan a bundle for embedded secrets. Returns every violation (empty == clean).
 * Rule-first (named provider patterns), then an entropy pass over long quoted
 * tokens. Pure; reads source text only.
 */
export function scanSecrets(bundle: Bundle): SecretViolation[] {
  const violations: SecretViolation[] = [];

  for (const [file, source] of Object.entries(bundle)) {
    const lines = source.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      // Pass 1: named provider rules.
      for (const { rule, pattern } of SECRET_RULES) {
        const m = pattern.exec(line);
        if (m) {
          violations.push({ rule, file, line: lineNo, preview: redact(m[0]) });
        }
      }

      // Pass 2: entropy over long quoted tokens not already flagged by a rule.
      for (const token of entropyCandidates(line)) {
        if (token.length < ENTROPY_MIN_LEN) continue;
        if (shannonEntropy(token) >= ENTROPY_THRESHOLD) {
          // Avoid double-reporting a token a named rule already caught on this line.
          const already = violations.some(
            (v) => v.file === file && v.line === lineNo && v.rule !== "high-entropy-string",
          );
          if (!already) {
            violations.push({
              rule: "high-entropy-string",
              file,
              line: lineNo,
              preview: redact(token),
            });
          }
        }
      }
    });
  }

  return violations;
}
