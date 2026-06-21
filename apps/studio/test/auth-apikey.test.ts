// auth-apikey.test.ts - STU-05 / ASVS V6 API-key mint + hash-at-rest + compare.
//
// Covers: (1) mintApiKey returns { raw, hash } where raw is a `utk_`-prefixed random
// token (shown ONCE) and hash is its SHA-256 - only the hash is meant to persist;
// (2) verifyApiKey re-hashes the raw and compares constant-time - a wrong key fails,
// the right key passes, and a length-mismatched hash does not throw; (3) the per-
// creator store persists ONLY hashes (never the raw), mirroring InMemoryIndexStore;
// (4) a source grep finds no raw-key persistence/log (asserted in the verify step,
// here we assert behaviorally the store never returns a raw key).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

describe("mintApiKey", () => {
  it("returns a utk_-prefixed random raw key and its SHA-256 hash", async () => {
    const { mintApiKey } = await import("../app/auth/apikey.server");
    const { raw, hash } = mintApiKey();
    expect(raw.startsWith("utk_")).toBe(true);
    // base64url body after the prefix, non-trivial length (>=24 bytes => >=32 chars)
    expect(raw.length).toBeGreaterThanOrEqual("utk_".length + 32);
    expect(raw).toMatch(/^utk_[A-Za-z0-9_-]+$/);
    // hash is the hex SHA-256 of the raw (64 hex chars)
    expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different raw key (and hash) on each mint", async () => {
    const { mintApiKey } = await import("../app/auth/apikey.server");
    const a = mintApiKey();
    const b = mintApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("verifyApiKey (constant-time)", () => {
  it("accepts the raw key against its own stored hash", async () => {
    const { mintApiKey, verifyApiKey } = await import("../app/auth/apikey.server");
    const { raw, hash } = mintApiKey();
    expect(verifyApiKey(raw, hash)).toBe(true);
  });

  it("rejects a wrong raw key against a stored hash", async () => {
    const { mintApiKey, verifyApiKey } = await import("../app/auth/apikey.server");
    const { hash } = mintApiKey();
    const other = mintApiKey();
    expect(verifyApiKey(other.raw, hash)).toBe(false);
  });

  it("does not throw and returns false for a malformed/length-mismatched stored hash", async () => {
    const { mintApiKey, verifyApiKey } = await import("../app/auth/apikey.server");
    const { raw } = mintApiKey();
    expect(verifyApiKey(raw, "deadbeef")).toBe(false); // shorter than a sha256 hex
    expect(verifyApiKey(raw, "")).toBe(false);
  });
});

describe("ApiKeyStore (hash at rest, per creator)", () => {
  it("persists only the hash and verifies a presented raw key for the creator", async () => {
    const { InMemoryApiKeyStore } = await import("../app/auth/apikey.server");
    const store = new InMemoryApiKeyStore();
    const creator = "0x1111111111111111111111111111111111111111";
    const { raw } = await store.mintFor(creator);
    // the store verifies the raw against the persisted hash
    expect(await store.verifyFor(creator, raw)).toBe(true);
    expect(await store.verifyFor(creator, "utk_wrong")).toBe(false);
  });

  it("never exposes a raw key from its persisted state", async () => {
    const { InMemoryApiKeyStore } = await import("../app/auth/apikey.server");
    const store = new InMemoryApiKeyStore();
    const creator = "0x2222222222222222222222222222222222222222";
    const { raw } = await store.mintFor(creator);
    const stored = await store.listHashes(creator);
    expect(stored.length).toBe(1);
    // the persisted record is the hash, NOT the raw key
    expect(stored[0]).not.toContain(raw);
    expect(stored[0]).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("scopes keys per creator (a key minted for A does not verify for B)", async () => {
    const { InMemoryApiKeyStore } = await import("../app/auth/apikey.server");
    const store = new InMemoryApiKeyStore();
    const a = "0x1111111111111111111111111111111111111111";
    const b = "0x2222222222222222222222222222222222222222";
    const { raw } = await store.mintFor(a);
    expect(await store.verifyFor(b, raw)).toBe(false);
  });
});
