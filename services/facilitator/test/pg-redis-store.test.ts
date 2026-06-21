// Behavioral conformance suite for the REAL pg+redis store adapter
// (services/facilitator/src/stores/pgRedis.ts -- PgRedisPaymentStore +
// PgRedisResultStore), run fully OFFLINE against hand-rolled faithful fakes of the
// exact pg.Pool / ioredis.Redis command surface the adapter calls. No real
// Postgres/Redis, no Docker, no new npm dependency.
//
// This closes the v1.0 working-audit coverage gap: the pg+redis adapter previously
// shipped behavior-UNVERIFIED (type-checked only). Here its Redis key naming, SET NX
// semantics, MULTI atomicity, pg INSERT...ON CONFLICT idempotency, and TTL-expiry
// logic are actually EXECUTED, asserting the SAME contract the in-memory adapter
// satisfies in packages/x402-arc/test/store.test.ts.
//
// DETERMINISTIC TIME: the adapter reads Date.now() directly (reserve TTL math,
// ResultStore.get expiry). The fakes compute key expiry off the SAME Date.now(), and
// the tests drive that clock with vitest fake timers. No wall-clock sleeps anywhere.
//
// Money: every USDC amount stays a bigint / base-unit string at the boundary exactly
// as the adapter does (caps are lock.cap.toString()); never a JS number for a USDC
// amount, never a decimals literal.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hex } from "viem";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  PgRedisPaymentStore,
  PgRedisResultStore,
} from "../src/stores/pgRedis";
import type { ReservationLock, StoredResult } from "@utter/x402-arc";

// --------------------------------------------------------------------------- //
// FakeRedis: emulates ONLY the ioredis.Redis command surface pgRedis.ts calls.  //
// String/lock keys live in `strings` (expireAt null = permanent); sets live in   //
// `sets`. Expiry is lazy and driven off Date.now() (the same clock the test      //
// fakes), mirroring InMemoryResultStore's lazy-expiry model.                     //
// --------------------------------------------------------------------------- //

interface StringEntry {
  val: string;
  expireAt: number | null; // null = permanent (no TTL)
}

/** A queued MULTI op applied atomically (in queue order) on exec(). */
type MultiOp = () => void;

class FakeMulti {
  private readonly ops: MultiOp[] = [];
  private readonly redis: FakeRedis;

  constructor(redis: FakeRedis) {
    this.redis = redis;
  }

  del(key: string): this {
    this.ops.push(() => this.redis._delString(key));
    return this;
  }

  srem(setKey: string, member: string): this {
    this.ops.push(() => this.redis._srem(setKey, [member]));
    return this;
  }

  // The 2-arg permanent form used by markNonceSpent (multi.set(spent, "1")).
  set(key: string, val: string): this {
    this.ops.push(() => this.redis._setString(key, val, null));
    return this;
  }

  async exec(): Promise<unknown[]> {
    // Apply ALL queued ops atomically (one synchronous pass, in queue order).
    for (const op of this.ops) op();
    return [];
  }
}

class FakeRedis {
  private readonly strings = new Map<string, StringEntry>();
  private readonly sets = new Map<string, Set<string>>();

  // TEETH KNOB (test-only): when true, set(...,"NX") ignores the NX guard and
  // overwrites instead of returning null. Used to PROVE the suite reddens, then
  // restored to false. NEVER a production-logic change -- this is the fake's own knob.
  sabotageNxOverwrites = false;

  // ---- internal helpers (lazy expiry off Date.now()) ---- //

  private _isLive(entry: StringEntry | undefined): entry is StringEntry {
    if (!entry) return false;
    if (entry.expireAt !== null && entry.expireAt <= Date.now()) return false;
    return true;
  }

  private _liveEntry(key: string): StringEntry | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && entry.expireAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  _setString(key: string, val: string, expireAt: number | null): void {
    this.strings.set(key, { val, expireAt });
  }

  _delString(key: string): void {
    this.strings.delete(key);
  }

  _srem(setKey: string, members: string[]): void {
    const set = this.sets.get(setKey);
    if (!set) return;
    for (const m of members) set.delete(m);
    if (set.size === 0) this.sets.delete(setKey);
  }

  /** Test introspection: the live members of a set (post lazy nothing -- sets have no TTL). */
  _setMembers(setKey: string): string[] {
    return [...(this.sets.get(setKey) ?? new Set<string>())];
  }

  // ---- ioredis command surface ---- //

  async exists(key: string): Promise<number> {
    return this._liveEntry(key) ? 1 : 0;
  }

  // Overloaded set: (key,val,"PX",ttl,"NX") | (key,val,"PX",ttl) | (key,val,"NX").
  async set(
    key: string,
    val: string,
    mode1?: "PX" | "NX",
    ttlMs?: number,
    mode2?: "NX",
  ): Promise<"OK" | null> {
    // (key, val, "PX", ttlMs, "NX") -- reservation lock: write only when absent.
    if (mode1 === "PX" && mode2 === "NX") {
      const live = this._liveEntry(key);
      if (live && !this.sabotageNxOverwrites) return null;
      this._setString(key, val, Date.now() + (ttlMs as number));
      return "OK";
    }
    // (key, val, "PX", ttlMs) -- write with TTL, overwrites (no NX). The cap value.
    if (mode1 === "PX" && mode2 === undefined) {
      this._setString(key, val, Date.now() + (ttlMs as number));
      return "OK";
    }
    // (key, val, "NX") -- permanent first-write-wins (spent marker / settle-tx hash).
    if (mode1 === "NX") {
      const live = this._liveEntry(key);
      if (live && !this.sabotageNxOverwrites) return null;
      this._setString(key, val, null);
      return "OK";
    }
    throw new Error(`FakeRedis.set: unsupported arg shape ${mode1}/${ttlMs}/${mode2}`);
  }

  async get(key: string): Promise<string | null> {
    const entry = this._liveEntry(key);
    return entry ? entry.val : null;
  }

  async incr(key: string): Promise<number> {
    const entry = this._liveEntry(key);
    const next = (entry ? Number(entry.val) : 0) + 1;
    this._setString(key, String(next), entry ? entry.expireAt : null);
    return next;
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

  async srem(setKey: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(setKey);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed += 1;
    }
    if (set.size === 0) this.sets.delete(setKey);
    return removed;
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

  async del(key: string): Promise<number> {
    const had = this.strings.has(key);
    this.strings.delete(key);
    return had ? 1 : 0;
  }

  multi(): FakeMulti {
    return new FakeMulti(this);
  }
}

// --------------------------------------------------------------------------- //
// FakePgPool: one async query(sql, params) method backed by two Maps keyed on   //
// idem_key (payments + results). Matches the adapter's fixed SQL literals on     //
// substrings. Honors ON CONFLICT DO UPDATE (payments) vs DO NOTHING (results).   //
// --------------------------------------------------------------------------- //

interface PaymentRow {
  idem_key: string;
  buyer: string;
  resource_id: string;
  cap: string;
  status: string;
}

interface ResultRow {
  idem_key: Hex;
  response: string;
  receipt: unknown;
  stored_at: string;
  expires_at: string;
}

class FakePgPool {
  private readonly payments = new Map<string, PaymentRow>();
  private readonly results = new Map<string, ResultRow>();

  // TEETH KNOB (test-only): when true, the results INSERT ON CONFLICT OVERWRITES
  // the existing row instead of DO NOTHING. Used to PROVE the idempotent-put
  // assertion reddens, then restored to false. NEVER a production-logic change.
  sabotageResultsOverwrite = false;

  /** Test introspection. */
  _paymentRow(idemKey: string): PaymentRow | undefined {
    return this.payments.get(idemKey);
  }

  async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    // payments INSERT ... ON CONFLICT (idem_key) DO UPDATE SET status = 'reserved'
    if (sql.includes("INSERT INTO payments")) {
      const [idemKey, buyer, resourceId, cap] = params as [string, string, string, string];
      const existing = this.payments.get(idemKey);
      if (existing) {
        existing.status = "reserved";
      } else {
        this.payments.set(idemKey, {
          idem_key: idemKey,
          buyer,
          resource_id: resourceId,
          cap,
          status: "reserved",
        });
      }
      return { rows: [] };
    }

    // payments UPDATE ... SET status = '<target>' WHERE idem_key = $1
    if (sql.includes("UPDATE payments")) {
      const [idemKey] = params as [string];
      const match = sql.match(/SET status = '(\w+)'/);
      const target = match ? match[1] : undefined;
      const row = this.payments.get(idemKey);
      if (row && target) row.status = target;
      return { rows: [] };
    }

    // results INSERT ... ON CONFLICT (idem_key) DO NOTHING
    if (sql.includes("INSERT INTO results")) {
      const [idemKey, response, receiptJson, storedAtMs, expiresAtIso] =
        params as [Hex, string, string, number, string];
      const existing = this.results.get(idemKey);
      if (existing && !this.sabotageResultsOverwrite) {
        // ON CONFLICT DO NOTHING -- the idempotency guarantee under test.
        return { rows: [] };
      }
      // to_timestamp($4 / 1000.0): persist an ISO string derived from storedAtMs so
      // the adapter recovers storedAtMs via new Date(stored_at).getTime().
      this.results.set(idemKey, {
        idem_key: idemKey,
        response,
        receipt: JSON.parse(receiptJson),
        stored_at: new Date(storedAtMs).toISOString(),
        expires_at: expiresAtIso,
      });
      return { rows: [] };
    }

    // results SELECT idem_key, response, receipt, stored_at, expires_at ...
    if (sql.includes("SELECT idem_key, response")) {
      const [idemKey] = params as [string];
      const row = this.results.get(idemKey);
      return { rows: row ? ([row] as unknown as T[]) : [] };
    }

    throw new Error(`FakePgPool.query: unmatched SQL: ${sql.slice(0, 40)}`);
  }
}

// --------------------------------------------------------------------------- //
// Test fixtures (bytes32 Hex nonces / 20-byte Hex buyers, mirroring store.test).//
// --------------------------------------------------------------------------- //

const NONCE: Hex = `0x${"11".repeat(32)}`;
const RESOURCE: Hex = `0x${"22".repeat(32)}`;
const BUYER: Hex = `0x${"33".repeat(20)}`;

function makeFakes() {
  const fakePg = new FakePgPool();
  const fakeRedis = new FakeRedis();
  const payments = new PgRedisPaymentStore(
    fakePg as unknown as Pool,
    fakeRedis as unknown as Redis,
  );
  const results = new PgRedisResultStore(fakePg as unknown as Pool);
  return { fakePg, fakeRedis, payments, results };
}

function lock(overrides: Partial<ReservationLock> = {}): ReservationLock {
  return {
    idemKey: NONCE,
    buyer: BUYER,
    cap: 10_000n,
    resourceId: RESOURCE,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// --------------------------------------------------------------------------- //
// PgRedisPaymentStore conformance                                              //
// --------------------------------------------------------------------------- //

describe("PgRedisPaymentStore (real adapter, hand-rolled pg/redis fakes)", () => {
  let fakePg: FakePgPool;
  let fakeRedis: FakeRedis;
  let payments: PgRedisPaymentStore;

  beforeEach(() => {
    ({ fakePg, fakeRedis, payments } = makeFakes());
  });

  it("round-trips reserve -> isNoncePending -> release", async () => {
    expect(await payments.reserve(lock())).toBe(true);
    expect(await payments.isNoncePending(NONCE)).toBe(true);
    await payments.release(NONCE);
    expect(await payments.isNoncePending(NONCE)).toBe(false);
    // The durable pg ledger row reflects the release.
    expect(fakePg._paymentRow(NONCE)?.status).toBe("released");
  });

  it("reserve honors SET NX: a second reserve of the same live nonce returns false (no double-reserve)", async () => {
    expect(await payments.reserve(lock())).toBe(true);
    expect(
      await payments.reserve(lock()),
      "a second reserve of a live nonce must fail -- SET NX lost the race (no double-reserve)",
    ).toBe(false);
  });

  it("a spent nonce can never be re-reserved (the exists(spent:..) short-circuit)", async () => {
    expect(await payments.reserve(lock())).toBe(true);
    await payments.markNonceSpent(NONCE);
    expect(
      await payments.reserve(lock()),
      "a spent nonce must never be re-reservable (replay guard)",
    ).toBe(false);
  });

  it("markNonceSpent is atomic: spent marker set AND reservation lock dropped AND per-buyer set member dropped in one multi().exec()", async () => {
    expect(await payments.reserve(lock())).toBe(true);
    const buyerKey = BUYER.toLowerCase();
    // Pre-condition: the per-buyer SET carries the live reservation member.
    expect(fakeRedis._setMembers(`resvbuyerset:${buyerKey}`)).toContain(NONCE);

    await payments.markNonceSpent(NONCE);

    // (1) spent marker is set: re-reserve is blocked.
    expect(
      await payments.reserve(lock()),
      "spent marker must block re-reserve after markNonceSpent",
    ).toBe(false);
    // (2) the reservation lock resv:<idemKey> is deleted: isNoncePending -> false.
    expect(await payments.isNoncePending(NONCE)).toBe(false);
    // (3) the per-buyer set member is dropped: outstandingReserved no longer counts it.
    expect(fakeRedis._setMembers(`resvbuyerset:${buyerKey}`)).not.toContain(NONCE);
    expect(await payments.outstandingReserved(BUYER)).toBe(0n);
    // The pg ledger row reflects settled.
    expect(fakePg._paymentRow(NONCE)?.status).toBe("settled");
  });

  it("outstandingReserved sums live caps for ONE buyer (case-insensitive) and excludes others", async () => {
    const nonceA: Hex = `0x${"a1".repeat(32)}`;
    const nonceB: Hex = `0x${"b2".repeat(32)}`;
    const nonceC: Hex = `0x${"c3".repeat(32)}`;
    const otherBuyer: Hex = `0x${"44".repeat(20)}`;
    await payments.reserve(lock({ idemKey: nonceA, cap: 1_000n }));
    await payments.reserve(lock({ idemKey: nonceB, cap: 2_500n }));
    await payments.reserve(lock({ idemKey: nonceC, cap: 9_999n, buyer: otherBuyer }));

    expect(await payments.outstandingReserved(BUYER)).toBe(3_500n);
    // Case-insensitive buyer match.
    expect(await payments.outstandingReserved(BUYER.toUpperCase() as Hex)).toBe(3_500n);
    expect(await payments.outstandingReserved(otherBuyer)).toBe(9_999n);

    await payments.release(nonceA);
    expect(await payments.outstandingReserved(BUYER)).toBe(2_500n);
  });

  it("outstandingReserved LAZILY PRUNES a TTL-expired member (cap drops to 0 AND the idemKey is SREM'd)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    const buyerKey = BUYER.toLowerCase();
    await payments.reserve(lock({ cap: 5_000n, expiresAt: Date.now() + 1_000 }));
    expect(await payments.outstandingReserved(BUYER)).toBe(5_000n);
    expect(fakeRedis._setMembers(`resvbuyerset:${buyerKey}`)).toContain(NONCE);

    // Advance past the cap key's PX TTL.
    vi.advanceTimersByTime(2_000);

    expect(await payments.outstandingReserved(BUYER)).toBe(0n);
    // The expired idemKey was pruned from the per-buyer set.
    expect(fakeRedis._setMembers(`resvbuyerset:${buyerKey}`)).not.toContain(NONCE);
  });

  it("recordSettleTx is FIRST-WRITE-WINS: a second record does not overwrite the first hash", async () => {
    const txA: Hex = `0x${"aa".repeat(32)}`;
    const txB: Hex = `0x${"bb".repeat(32)}`;
    await payments.recordSettleTx(NONCE, txA);
    await payments.recordSettleTx(NONCE, txB);
    expect(
      await payments.getSettleTx(NONCE),
      "recordSettleTx must be first-write-wins -- SET NX keeps the first broadcast's tx hash",
    ).toBe(txA);
  });

  it("recordStrike increments getStrikes per resource", async () => {
    expect(await payments.getStrikes(RESOURCE)).toBe(0);
    await payments.recordStrike(RESOURCE, "invalid_output");
    await payments.recordStrike(RESOURCE, "timeout");
    expect(await payments.getStrikes(RESOURCE)).toBe(2);
  });
});

// --------------------------------------------------------------------------- //
// PgRedisResultStore conformance                                               //
// --------------------------------------------------------------------------- //

describe("PgRedisResultStore (real adapter, hand-rolled pg fake)", () => {
  let results: PgRedisResultStore;

  beforeEach(() => {
    ({ results } = makeFakes());
  });

  const baseResult: StoredResult = {
    idemKey: NONCE,
    response: JSON.stringify({ echo: "hi", length: 2 }),
    receipt: { tx: `0x${"ab".repeat(32)}`, amount: "10000" },
    storedAt: Date.now(),
  };

  it("put then get round-trips the stored result within TTL (idemKey/response/receipt/storedAt)", async () => {
    expect(await results.get(NONCE)).toBeNull();
    const result: StoredResult = { ...baseResult, storedAt: Date.now() };
    await results.put(result, 3600);
    const got = await results.get(NONCE);
    expect(got).toEqual(result);
  });

  it("put is IDEMPOTENT (ON CONFLICT DO NOTHING): a retried put with DIFFERENT data does not overwrite", async () => {
    const first: StoredResult = {
      ...baseResult,
      response: JSON.stringify({ first: true }),
      receipt: { tx: `0x${"11".repeat(32)}`, amount: "1000" },
      storedAt: Date.now(),
    };
    const second: StoredResult = {
      ...baseResult,
      response: JSON.stringify({ first: false, overwritten: true }),
      receipt: { tx: `0x${"22".repeat(32)}`, amount: "9999" },
      storedAt: Date.now(),
    };
    await results.put(first, 3600);
    await results.put(second, 3600);
    const got = await results.get(NONCE);
    expect(
      got?.response,
      "a retried put must NOT overwrite the stored row (ON CONFLICT DO NOTHING)",
    ).toBe(first.response);
    expect(got?.receipt).toEqual(first.receipt);
  });

  it("get treats a TTL-EXPIRED row as absent (returns null -- the GET /results 404 path)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    await results.put({ ...baseResult, storedAt: Date.now() }, 1);
    expect(await results.get(NONCE)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(
      await results.get(NONCE),
      "an expired idemKey must 404 (return null) past its TTL",
    ).toBeNull();
  });
});
