// apikey.server.ts - STU-05 per-creator API keys (ASVS V6, D-STU-05).
//
// API keys give an agent operator programmatic (non-SIWE) access. The key material
// discipline (T-06-APIKEY, 06-RESEARCH Security Domain V6):
//   - the RAW key is a random 24-byte token, base64url, prefixed `utk_`;
//   - the raw is returned EXACTLY ONCE (at mint) and NEVER persisted or logged;
//   - only the SHA-256 hash of the raw is stored at rest;
//   - verification re-hashes the presented raw and compares CONSTANT-TIME
//     (crypto.timingSafeEqual) against the stored hash, so a timing side channel
//     cannot leak the hash byte-by-byte.
// This module makes zero console.* calls - the raw key never reaches a log line.
//
// The InMemoryApiKeyStore is the autonomous test default, mirroring the marketplace
// InMemoryIndexStore idiom (Map-backed, shallow-copy on read). A real deployment
// swaps a Postgres-shaped store implementing the same interface; it persists ONLY
// the hash column - never the raw key.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The shown-once API key prefix (so a leaked token is recognizable in support). */
const API_KEY_PREFIX = "utk_";

/** SHA-256 hex of a raw key - the ONLY form persisted at rest. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mint a fresh API key. Returns { raw, hash }: `raw` is shown to the creator ONCE
 * and never stored; `hash` is the SHA-256 the caller persists. 24 random bytes give
 * 192 bits of entropy - well beyond brute-force.
 */
export function mintApiKey(): { raw: string; hash: string } {
  const raw = API_KEY_PREFIX + randomBytes(24).toString("base64url");
  const hash = hashApiKey(raw);
  return { raw, hash };
}

/**
 * Verify a presented raw key against a stored hash in CONSTANT TIME. Re-hashes the
 * raw and compares the two hex digests with timingSafeEqual. Returns false (never
 * throws) for a malformed/length-mismatched stored hash so the call site can treat
 * any failure uniformly without a side channel.
 */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const computed = hashApiKey(raw);
  // timingSafeEqual requires equal-length buffers; a length mismatch is a definite
  // non-match (and avoids throwing on a malformed stored hash).
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The per-creator API-key store contract. Persists ONLY hashes (never raw keys).
 * The Postgres adapter (real runs) implements the same interface so call sites swap
 * by env without change.
 */
export interface ApiKeyStore {
  /** Mint a new key for a creator; persists the hash, returns the shown-once raw. */
  mintFor(creator: string): Promise<{ raw: string }>;
  /** Verify a presented raw key for a creator against that creator's stored hashes. */
  verifyFor(creator: string, raw: string): Promise<boolean>;
  /** List the persisted hashes for a creator (NEVER raw keys) - support/audit only. */
  listHashes(creator: string): Promise<string[]>;
}

/**
 * The in-memory API-key store (autonomous test default). Keyed by creator address;
 * the value is the SET OF HASHES for that creator - no raw key ever enters the map.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly hashesByCreator = new Map<string, Set<string>>();

  async mintFor(creator: string): Promise<{ raw: string }> {
    const { raw, hash } = mintApiKey();
    const set = this.hashesByCreator.get(creator) ?? new Set<string>();
    set.add(hash); // persist the HASH only; `raw` is returned and then discarded
    this.hashesByCreator.set(creator, set);
    return { raw };
  }

  async verifyFor(creator: string, raw: string): Promise<boolean> {
    const set = this.hashesByCreator.get(creator);
    if (!set || set.size === 0) return false;
    // Constant-time compare against each stored hash; any match authenticates.
    for (const storedHash of set) {
      if (verifyApiKey(raw, storedHash)) return true;
    }
    return false;
  }

  async listHashes(creator: string): Promise<string[]> {
    return [...(this.hashesByCreator.get(creator) ?? new Set<string>())];
  }
}
