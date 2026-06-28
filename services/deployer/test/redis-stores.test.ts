// Behavioral conformance suite for the durable Redis-backed deployer store adapter
// (services/deployer/src/stores/redis.ts -- RedisDeploymentStore +
// RedisResponseCache), run fully OFFLINE against a hand-rolled faithful fake of the
// exact ioredis.Redis command surface the adapter calls. No real Redis, no Docker,
// no new npm dependency.
//
// This proves the Redis adapter honors the IDENTICAL DeploymentStore + ResponseCache
// contract the in-memory adapter satisfies: the atomic Lua slug-claim (M5
// SlugConflictError on a cross-resourceId slug reuse; DEP-04 idempotent same-
// resourceId re-put; an own-slug change frees the old slug), the cap bigint round-
// trip as a base-unit string, and the cache TTL + prefix-scoped invalidation.
//
// FAITHFUL LUA: the fake's eval() re-implements the adapter's SLUG_CLAIM_SCRIPT
// semantics in TypeScript (the SAME check-then-claim ordering, the SAME conflict
// signal {1, existingOwner}, the SAME own-slug-change DEL). A test-only "teeth" knob
// (sabotageSlugClaim) bypasses the cross-resourceId conflict check to PROVE the M5
// assertion reddens, then is restored -- never a production-logic change.
//
// DETERMINISTIC TIME: the cache reads expiry off Date.now() (SET PX). The fake
// computes string-key expiry off the SAME Date.now(), driven by vitest fake timers.
// No wall-clock sleeps.
//
// Money: the cap stays a bigint -> base-unit string at the boundary exactly as the
// adapter does; never a JS number for a USDC amount, never a decimals literal.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hex } from "viem";
import type { Redis } from "ioredis";
import {
  RedisDeploymentStore,
  RedisResponseCache,
} from "../src/stores/redis";
import { SlugConflictError, type DeploymentRecord } from "../src/stores/memory";

// --------------------------------------------------------------------------- //
// FakeRedis: emulates ONLY the ioredis.Redis surface redis.ts calls --          //
// eval (the slug-claim script), get, set (PX), del, sadd, smembers, mget, scan. //
// String keys live in `strings` (expireAt null = permanent, the rec/slug keys); //
// sets live in `sets` (deploy:all). Expiry is lazy off Date.now() (the clock the //
// tests fake), mirroring the in-memory cache's lazy-expiry model.               //
// --------------------------------------------------------------------------- //

interface StringEntry {
  val: string;
  expireAt: number | null; // null = permanent (no TTL)
}

class FakeRedis {
  private readonly strings = new Map<string, StringEntry>();
  private readonly sets = new Map<string, Set<string>>();

  // TEETH KNOB (test-only): when true, eval()'s slug-claim BYPASSES the cross-
  // resourceId conflict check and claims anyway (never signals {1, ...}). Used to
  // PROVE the M5 SlugConflictError assertion reddens, then restored to false.
  // NEVER a production-logic change -- this is the fake's own knob.
  sabotageSlugClaim = false;

  private _liveEntry(key: string): StringEntry | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && entry.expireAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Test introspection: live members of a set. */
  _setMembers(setKey: string): string[] {
    return [...(this.sets.get(setKey) ?? new Set<string>())];
  }

  // ---- ioredis command surface ---- //

  async get(key: string): Promise<string | null> {
    const entry = this._liveEntry(key);
    return entry ? entry.val : null;
  }

  // The adapter only ever calls set(key, val, "PX", ttlMs) for the cache.
  async set(key: string, val: string, mode?: "PX", ttlMs?: number): Promise<"OK"> {
    if (mode === "PX" && ttlMs !== undefined) {
      this.strings.set(key, { val, expireAt: Date.now() + ttlMs });
      return "OK";
    }
    throw new Error(`FakeRedis.set: unsupported arg shape ${mode}/${ttlMs}`);
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
    }
    return removed;
  }

  async sadd(setKey: string, member: string): Promise<number> {
    let set = this.sets.get(setKey);
    if (!set) {
      set = new Set<string>();
      this.sets.set(setKey, set);
    }
    const had = set.has(member);
    set.add(member);
    return had ? 0 : 1;
  }

  async smembers(setKey: string): Promise<string[]> {
    return [...(this.sets.get(setKey) ?? new Set<string>())];
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => {
      const entry = this._liveEntry(k);
      return entry ? entry.val : null;
    });
  }

  // Faithful SCAN: one cursor pass returns ALL matching live keys (the adapter
  // loops until the cursor is "0"; returning "0" in one pass is a valid SCAN
  // contract). MATCH <prefix>* is emulated as startsWith(prefix).
  async scan(
    _cursor: string,
    _matchToken: "MATCH",
    pattern: string,
    _countToken: "COUNT",
    _count: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    const keys: string[] = [];
    for (const key of this.strings.keys()) {
      if (key.startsWith(prefix) && this._liveEntry(key)) keys.push(key);
    }
    return ["0", keys];
  }

  // Faithful re-implementation of redis.ts's SLUG_CLAIM_SCRIPT. ARGV order matches
  // the adapter: [resourceId, slug, recJson, slugPrefix, recPrefix, allSet].
  async eval(_script: string, _numKeys: number, ...argv: string[]): Promise<[number, string?]> {
    const [resourceId, slug, recJson, slugPrefix, recPrefix, allSet] = argv as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const slugKey = `${slugPrefix}${slug}`;

    // (1) Cross-resourceId conflict check (skipped by the teeth knob to redden M5).
    const existingOwner = (await this.get(slugKey)) ?? null;
    if (!this.sabotageSlugClaim && existingOwner && existingOwner !== resourceId) {
      return [1, existingOwner];
    }

    // (2) Own-slug change: free the stale reverse-index entry.
    const recKey = `${recPrefix}${resourceId}`;
    const prevRaw = await this.get(recKey);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw) as { slug?: string };
      if (prev.slug && prev.slug !== slug) {
        this.strings.delete(`${slugPrefix}${prev.slug}`);
      }
    }

    // (3) Write the rec, claim the slug, SADD to the all-set (permanent keys).
    this.strings.set(recKey, { val: recJson, expireAt: null });
    this.strings.set(slugKey, { val: resourceId, expireAt: null });
    await this.sadd(allSet, resourceId);
    return [0];
  }
}

// --------------------------------------------------------------------------- //
// Test fixtures (bytes32 Hex resourceIds, 20-byte Hex agentIds).               //
// --------------------------------------------------------------------------- //

const AGENT: Hex = `0x${"aa".repeat(20)}`;
const RES_A: Hex = `0x${"11".repeat(32)}`;
const RES_B: Hex = `0x${"22".repeat(32)}`;

function makeStores() {
  const fakeRedis = new FakeRedis();
  const deployments = new RedisDeploymentStore(fakeRedis as unknown as Redis);
  const cache = new RedisResponseCache(fakeRedis as unknown as Redis);
  return { fakeRedis, deployments, cache };
}

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    agentId: AGENT,
    resourceId: RES_A,
    slug: "weather",
    deployVersion: 1,
    status: "running",
    updatedAt: 1_700_000_000_000,
    cap: 10_000n,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// --------------------------------------------------------------------------- //
// RedisDeploymentStore conformance                                             //
// --------------------------------------------------------------------------- //

describe("RedisDeploymentStore (real adapter, hand-rolled redis fake)", () => {
  let fakeRedis: FakeRedis;
  let deployments: RedisDeploymentStore;

  beforeEach(() => {
    ({ fakeRedis, deployments } = makeStores());
  });

  it("put -> get -> getBySlug -> list round-trips a record (cap bigint preserved)", async () => {
    expect(await deployments.get(RES_A)).toBeNull();
    expect(await deployments.getBySlug("weather")).toBeNull();

    const rec = record();
    await deployments.put(rec);

    expect(await deployments.get(RES_A)).toEqual(rec);
    expect(await deployments.getBySlug("weather")).toEqual(rec);
    expect(await deployments.list()).toEqual([rec]);
  });

  it("the cap round-trips as a base-unit string -> bigint (no precision loss, no number)", async () => {
    const bigCap = 123_456_789_012_345_678_901_234_567_890n;
    await deployments.put(record({ cap: bigCap }));
    const got = await deployments.get(RES_A);
    expect(got?.cap).toBe(bigCap);
    expect(typeof got?.cap).toBe("bigint");
  });

  it("a record with no cap round-trips as undefined", async () => {
    await deployments.put(record({ cap: undefined }));
    const got = await deployments.get(RES_A);
    expect(got?.cap).toBeUndefined();
  });

  it("M5: a cross-resourceId reuse of a claimed slug throws SlugConflictError", async () => {
    await deployments.put(record({ resourceId: RES_A, slug: "weather" }));
    await expect(
      deployments.put(record({ resourceId: RES_B, slug: "weather" })),
    ).rejects.toBeInstanceOf(SlugConflictError);

    // The original owner's record is left byte-for-byte unchanged and resolvable.
    const owner = await deployments.getBySlug("weather");
    expect(owner?.resourceId).toBe(RES_A);
  });

  it("M5 conflict names the slug + both resourceIds (operator diagnosability)", async () => {
    await deployments.put(record({ resourceId: RES_A, slug: "weather" }));
    try {
      await deployments.put(record({ resourceId: RES_B, slug: "weather" }));
      throw new Error("expected SlugConflictError");
    } catch (e) {
      expect(e).toBeInstanceOf(SlugConflictError);
      const err = e as SlugConflictError;
      expect(err.slug).toBe("weather");
      expect(err.existingResourceId).toBe(RES_A);
      expect(err.incomingResourceId).toBe(RES_B);
    }
  });

  it("DEP-04: a same-resourceId re-put (same slug, bumped version) is idempotent and never throws", async () => {
    await deployments.put(record({ deployVersion: 1 }));
    await expect(
      deployments.put(record({ deployVersion: 2, status: "running" })),
    ).resolves.toBeUndefined();
    const got = await deployments.get(RES_A);
    expect(got?.deployVersion).toBe(2);
  });

  it("an own-slug change frees the old slug (getBySlug(old) -> null, getBySlug(new) -> record)", async () => {
    await deployments.put(record({ resourceId: RES_A, slug: "old-slug" }));
    expect((await deployments.getBySlug("old-slug"))?.resourceId).toBe(RES_A);

    await deployments.put(record({ resourceId: RES_A, slug: "new-slug" }));
    expect(await deployments.getBySlug("old-slug")).toBeNull();
    expect((await deployments.getBySlug("new-slug"))?.resourceId).toBe(RES_A);

    // The freed slug is now claimable by a DIFFERENT resourceId (no false reserve).
    await expect(
      deployments.put(record({ resourceId: RES_B, slug: "old-slug" })),
    ).resolves.toBeUndefined();
    expect((await deployments.getBySlug("old-slug"))?.resourceId).toBe(RES_B);
  });

  it("list returns every record across resourceIds", async () => {
    await deployments.put(record({ resourceId: RES_A, slug: "a" }));
    await deployments.put(record({ resourceId: RES_B, slug: "b" }));
    const all = await deployments.list();
    expect(all.map((r) => r.resourceId).sort()).toEqual([RES_A, RES_B].sort());
  });

  it("getBySlug returns null for an unclaimed slug", async () => {
    expect(await deployments.getBySlug("nope")).toBeNull();
  });

  // TEETH: prove the M5 assertion reddens if the atomic claim is bypassed.
  it("TEETH: sabotaging the atomic slug-claim lets a cross-resourceId reuse through (proves the check has teeth)", async () => {
    await deployments.put(record({ resourceId: RES_A, slug: "weather" }));
    fakeRedis.sabotageSlugClaim = true;
    // With the conflict check bypassed, the second put does NOT throw -- which is
    // exactly the M5 regression the real check prevents.
    await expect(
      deployments.put(record({ resourceId: RES_B, slug: "weather" })),
    ).resolves.toBeUndefined();
    fakeRedis.sabotageSlugClaim = false;
  });
});

// --------------------------------------------------------------------------- //
// RedisResponseCache conformance                                               //
// --------------------------------------------------------------------------- //

describe("RedisResponseCache (real adapter, hand-rolled redis fake)", () => {
  let cache: RedisResponseCache;

  beforeEach(() => {
    ({ cache } = makeStores());
  });

  it("set then get round-trips a body within TTL", async () => {
    expect(await cache.get("resource:1:v1:abc")).toBeNull();
    await cache.set("resource:1:v1:abc", "cached-body", 3600);
    expect(await cache.get("resource:1:v1:abc")).toBe("cached-body");
  });

  it("get returns null past the TTL (server-side PX expiry)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T00:00:00Z"));
    await cache.set("k", "body", 1);
    expect(await cache.get("k")).toBe("body");
    vi.advanceTimersByTime(2_000);
    expect(await cache.get("k")).toBeNull();
  });

  it("delByPrefix removes ONLY the prefixed keys, leaving others intact", async () => {
    await cache.set("resource:1:v1:a", "a", 3600);
    await cache.set("resource:1:v1:b", "b", 3600);
    await cache.set("resource:1:v2:c", "c", 3600); // a different version prefix
    await cache.set("resource:2:v1:d", "d", 3600); // a different resource

    await cache.delByPrefix("resource:1:v1:");

    expect(await cache.get("resource:1:v1:a")).toBeNull();
    expect(await cache.get("resource:1:v1:b")).toBeNull();
    expect(await cache.get("resource:1:v2:c")).toBe("c");
    expect(await cache.get("resource:2:v1:d")).toBe("d");
  });

  it("delByPrefix is a no-op when nothing matches", async () => {
    await cache.set("keep", "v", 3600);
    await cache.delByPrefix("nomatch:");
    expect(await cache.get("keep")).toBe("v");
  });
});
