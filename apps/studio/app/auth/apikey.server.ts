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
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parsePositiveInt } from "../limits/fixed-window.server.js";

/** The shown-once API key prefix (so a leaked token is recognizable in support). */
const API_KEY_PREFIX = "utk_";

/**
 * Thrown by FileApiKeyStore.mintFor when a creator already holds the maximum number
 * of keys (API_KEYS_PER_CREATOR_MAX, default 50). Keys are stored as hashes on
 * disk, so an unbounded mint loop would grow the persisted file without limit; the
 * keys route catches this error specifically and surfaces the message inline.
 */
export class ApiKeyCapError extends Error {
  readonly code = "api_key_cap" as const;
  constructor(cap: number) {
    super(`api key limit reached (${cap} keys per creator); use an existing key`);
    this.name = "ApiKeyCapError";
  }
}

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
  /**
   * Reverse lookup: hash the presented raw key and return the creator whose stored
   * hash set contains it (constant-time compare per candidate), or null if no match.
   * This is the bearer-key auth path's resolver. The raw key is never logged.
   */
  resolveCreatorByKey(raw: string): Promise<string | null>;
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

  /**
   * Reverse lookup over the in-memory map: return the creator whose stored hash set
   * contains the presented raw key's hash (constant-time per candidate), or null.
   * The raw key is never logged.
   */
  async resolveCreatorByKey(raw: string): Promise<string | null> {
    if (typeof raw !== "string" || raw.length === 0) return null;
    for (const [creator, set] of this.hashesByCreator) {
      for (const storedHash of set) {
        if (verifyApiKey(raw, storedHash)) return creator;
      }
    }
    return null;
  }
}

/**
 * The on-disk JSON shape: a plain map mirroring the in-memory store (creator address
 * -> array of SHA-256 hash hex strings). ONLY hashes are persisted; the raw key never
 * touches disk. The array form mirrors the in-memory Set (deduped on load).
 */
type PersistShape = Record<string, string[]>;

/**
 * Resolve the durable store path. Reads STUDIO_API_KEYS_PATH when set (the test suite
 * points this at an OS temp file for hermetic runs); otherwise defaults to
 * <studio-app>/.data/api-keys.json. The default is resolved to a stable absolute path
 * relative to this compiled module so it does not depend on the process cwd.
 */
function defaultKeyStorePath(): string {
  const fromEnv = process.env.STUDIO_API_KEYS_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  // This module lives at <app>/app/auth/apikey.server.ts (or its compiled mirror), so
  // climb to the app root and place the file under .data/. import.meta.url is the
  // stable anchor (cwd-independent).
  const here = new URL(".", import.meta.url).pathname;
  // here ends at .../app/auth/ ; go up two to the app root.
  return resolve(here, "..", "..", ".data", "api-keys.json");
}

/**
 * A durable, file-backed API-key store. Same ApiKeyStore contract as the in-memory
 * variant (mintFor / verifyFor / listHashes), so call sites swap without change. It:
 *   - persists ONLY SHA-256 hashes (never the raw key) as a JSON map on disk;
 *   - loads on construct (missing/corrupt file -> start empty, never crash);
 *   - keeps an in-memory cache and persists on every mutation;
 *   - writes atomically (temp file in the same dir, then rename over the target).
 * This module makes zero console.* calls in the auth path; a single warning on a
 * corrupt file is the only diagnostic and it never echoes key material.
 */
export class FileApiKeyStore implements ApiKeyStore {
  private readonly filePath: string;
  private readonly hashesByCreator = new Map<string, Set<string>>();
  private readonly maxKeysPerCreator: number;

  constructor(
    filePath: string = defaultKeyStorePath(),
    opts: { maxKeysPerCreator?: number } = {},
  ) {
    this.filePath = filePath;
    this.maxKeysPerCreator =
      opts.maxKeysPerCreator ??
      parsePositiveInt(process.env.API_KEYS_PER_CREATOR_MAX, 50, "API_KEYS_PER_CREATOR_MAX");
    this.load();
  }

  /**
   * Load the persisted hashes into the in-memory cache. A missing file or corrupt
   * JSON degrades to an empty store (no throw) so a partial/garbled file can never
   * take the process down; a single warning is emitted (no key material in it).
   */
  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch {
      // Missing file (first run) - start empty, nothing to warn about.
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [creator, hashes] of Object.entries(parsed as PersistShape)) {
          if (!Array.isArray(hashes)) continue;
          const set = new Set<string>();
          for (const h of hashes) if (typeof h === "string") set.add(h);
          if (set.size > 0) this.hashesByCreator.set(creator, set);
        }
      }
    } catch {
      // Corrupt JSON - degrade to empty rather than crash. The warning carries no key
      // material (only the path), so it is safe to log.
      console.warn(
        `[apiKeyStore] could not parse ${this.filePath}; starting with an empty key store`,
      );
    }
  }

  /**
   * Persist the in-memory cache to disk atomically: serialize, write a temp file in
   * the SAME directory, then rename over the target (rename is atomic on the same
   * filesystem). The parent dir is created if missing. Only hashes are written.
   */
  private persist(): void {
    const shape: PersistShape = {};
    for (const [creator, set] of this.hashesByCreator) shape[creator] = [...set];

    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });

    // Unique temp name in the same dir so the rename stays on one filesystem.
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  async mintFor(creator: string): Promise<{ raw: string }> {
    const set = this.hashesByCreator.get(creator) ?? new Set<string>();
    // Hard per-creator cap: reject BEFORE minting so nothing is generated or
    // persisted for an over-cap request.
    if (set.size >= this.maxKeysPerCreator) {
      throw new ApiKeyCapError(this.maxKeysPerCreator);
    }
    const { raw, hash } = mintApiKey();
    set.add(hash); // persist the HASH only; `raw` is returned and then discarded
    this.hashesByCreator.set(creator, set);
    this.persist();
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

  /**
   * Reverse lookup: given a presented RAW key, return the creator whose stored hash
   * set contains its hash, comparing CONSTANT-TIME per candidate (verifyApiKey reuses
   * crypto.timingSafeEqual). Returns null when no creator matches. The raw key is
   * never logged. This powers the bearer-key auth path in requireCreator.
   */
  async resolveCreatorByKey(raw: string): Promise<string | null> {
    if (typeof raw !== "string" || raw.length === 0) return null;
    for (const [creator, set] of this.hashesByCreator) {
      for (const storedHash of set) {
        if (verifyApiKey(raw, storedHash)) return creator;
      }
    }
    return null;
  }
}
