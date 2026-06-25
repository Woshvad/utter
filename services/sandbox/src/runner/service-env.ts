// buildServiceEnv - the env allowlist + secret guard for the long-lived
// resource-service profile (RESOURCE-DEPLOY-DESIGN.md §2.3, "the security heart
// of relaxation 2").
//
// The one-shot run profile keeps env exactly empty (RunSpec.env is typed
// Record<string, never>). A long-lived service needs a small NON-SECRET config
// (facilitator base URL, the public resource id, listen port, public pricing
// terms). This module is the only place that config is admitted, deny-by-default,
// in two required layers:
//
//   Layer A - closed allowlist: any key not in SERVICE_ENV_ALLOWLIST is
//             rejected at build time. Every secret-bearing key from .env.example
//             (DATA_PROXY_TOKEN_SECRET, RELAYER_SIGNER_KEYS, *_PRIVATE_KEY,
//             SESSION_SECRET, DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY,
//             DNS_API_TOKEN) is deliberately absent.
//
//   Layer B - secret-shaped guard: even if a key were mistakenly added to the
//             allowlist later, a key-name denylist plus value-shape checks
//             (reusing the patterns trusted in prepublish/secret-scan.ts) reject
//             it. The Shannon-entropy pass is skipped only for a small set of
//             KNOWN_PUBLIC_CONSTANT keys (RESOURCE_ID, PRICE_ASSET) that are
//             legitimately high-entropy public constants (keccak id, the USDC
//             0x3600...0000 address) - mirroring scanSecrets' entropy:false
//             option for declarative public values.
//
// SECURITY: a ServiceEnvViolation carries the key name and a reason ONLY - NEVER
// the value. No secret is ever placed in an error or a log. The data-proxy still
// mints its short-lived scoped token at request time; that token is never part
// of a service's static env.
import { shannonEntropy } from "../prepublish/secret-scan";

/**
 * The closed allowlist of NON-SECRET service config keys. Layer A rejects any
 * key not in this set. These are public routing/identity/pricing identifiers,
 * not secrets.
 */
export const SERVICE_ENV_ALLOWLIST = [
  "FACILITATOR_URL", // non-secret control-plane base URL
  "RESOURCE_ID", // on-chain keccak identity (public)
  "PORT", // the service listen port
  "PRICE_AMOUNT", // public pricing term
  "PRICE_ASSET", // public pricing asset (USDC address)
  "PRICE_SCHEME", // public pricing scheme
  "PRICE_MAX", // public pricing cap
] as const;

/** The allowlisted key union (for type-safe callers). */
export type ServiceEnvKey = (typeof SERVICE_ENV_ALLOWLIST)[number];

const ALLOWLIST_SET: ReadonlySet<string> = new Set(SERVICE_ENV_ALLOWLIST);

/**
 * Keys whose values are legitimately high-entropy PUBLIC constants (the keccak
 * resource id and the USDC asset address). The named-pattern value checks still
 * run for these, but the generic entropy pass is skipped so a public constant is
 * not a false-positive. Mirrors scanSecrets({ entropy: false }) for declarative
 * public values.
 */
const KNOWN_PUBLIC_CONSTANT: ReadonlySet<string> = new Set<string>([
  "RESOURCE_ID",
  "PRICE_ASSET",
]);

/**
 * Layer B key-name denylist: a key whose NAME looks secret-bearing is rejected
 * even if it somehow reached the allowlist. Same word-stems the threat model
 * tracks for wallet/key/credential material.
 */
const SECRET_KEY_NAME =
  /(_KEY|SECRET|TOKEN|PASSWORD|PRIVATE|MNEMONIC|SEED|CREDENTIAL|SIGNER)/i;

/**
 * Layer B value-shape rules - the named-provider patterns reused from
 * prepublish/secret-scan.ts (SECRET_RULES). A value matching any of these is a
 * secret regardless of its key name. Kept in sync with secret-scan.ts.
 *
 * `publicConstantSafe` marks a rule that a KNOWN_PUBLIC_CONSTANT key is exempt
 * from. The hex-private-key shape (`0x<64hex>`) is byte-for-byte identical to a
 * keccak resource id, so for RESOURCE_ID / PRICE_ASSET this rule cannot
 * distinguish a public id from a private key by shape alone and must be skipped
 * for those keys (the closed allowlist + key-name denylist still gate them). The
 * sk-/PEM/AKIA/slack/github rules stay always-on for every key.
 */
const SECRET_VALUE_RULES: { rule: string; pattern: RegExp; publicConstantSafe?: boolean }[] = [
  { rule: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "openai-style-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { rule: "hex-private-key", pattern: /\b0x[a-fA-F0-9]{64}\b/, publicConstantSafe: true },
];

/** Entropy pass thresholds (mirroring secret-scan.ts). */
const ENTROPY_THRESHOLD = 4.0;
const ENTROPY_MIN_LEN = 20;

/**
 * A rejected env entry. Carries the offending KEY and a human reason ONLY -
 * never the value (no secret in an error or a log).
 */
export class ServiceEnvViolation extends Error {
  /** The offending env key (safe to log). */
  readonly key: string;
  /** Why it was rejected (safe to log). NEVER includes the value. */
  readonly reason: string;

  constructor(key: string, reason: string) {
    super(`service env rejected key '${key}': ${reason}`);
    this.name = "ServiceEnvViolation";
    this.key = key;
    this.reason = reason;
  }
}

/**
 * Validate a raw config map and return a safe, allowlisted env map.
 *
 * @throws {ServiceEnvViolation} if a key is not allowlisted (Layer A), or a key
 *         name looks secret-bearing, or a value is secret-shaped (Layer B). The
 *         thrown error carries the key + reason only, never the value.
 */
export function buildServiceEnv(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    // Layer A: closed allowlist.
    if (!ALLOWLIST_SET.has(key)) {
      throw new ServiceEnvViolation(key, "key is not in SERVICE_ENV_ALLOWLIST");
    }

    // Layer B (key name): a secret-bearing key name is rejected even if it were
    // allowlisted by a later edit.
    if (SECRET_KEY_NAME.test(key)) {
      throw new ServiceEnvViolation(key, "key name matches the secret-key denylist");
    }

    const isPublicConstant = KNOWN_PUBLIC_CONSTANT.has(key);

    // Layer B (value shape): named-provider patterns. All run for normal keys;
    // a KNOWN_PUBLIC_CONSTANT key is exempt only from `publicConstantSafe` rules
    // (the hex64 shape it shares with a keccak id). The sk-/PEM/AKIA/etc rules
    // still run for every key.
    for (const { rule, pattern, publicConstantSafe } of SECRET_VALUE_RULES) {
      if (isPublicConstant && publicConstantSafe) continue;
      if (pattern.test(value)) {
        throw new ServiceEnvViolation(key, `value matches secret pattern '${rule}'`);
      }
    }

    // Layer B (entropy): skipped only for KNOWN_PUBLIC_CONSTANT keys, whose
    // high-entropy values are public constants (keccak id / USDC address).
    if (!isPublicConstant) {
      const trimmed = value.trim();
      if (trimmed.length >= ENTROPY_MIN_LEN && shannonEntropy(trimmed) >= ENTROPY_THRESHOLD) {
        throw new ServiceEnvViolation(key, "value is high-entropy (possible secret)");
      }
    }

    out[key] = value;
  }

  return out;
}
