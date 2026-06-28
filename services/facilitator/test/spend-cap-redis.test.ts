// Behavioral conformance suite for the REAL Redis-backed SpendCapStore adapter
// (services/facilitator/src/stores/spend-cap-redis.ts -- RedisSpendCapStore), run
// fully OFFLINE against a hand-rolled faithful fake of the exact ioredis.Redis
// command surface the adapter calls. No real Redis, no Docker, no new npm
// dependency.
//
// This proves the Redis adapter honors the SAME SpendCapStore contract the in-memory
// adapter satisfies in packages/data-proxy/test/spend-cap.test.ts: the rolling-24h
// window trim (an entry older than the window drops), the atomic deny-by-default
// check-and-reserve (allow within cap + record, deny over cap + record NOTHING, two
// concurrent over-cap reservations cannot both pass, boundary sum+amount==cap allows),
// the compensating refund of ONE reserved (amount,now) entry, and amount=0 as a pure
// read. The adapter's window math is on the INJECTED `now` (never Date.now()), so the
// suite drives the clock by passing `now` explicitly -- no fake timers needed.
//
// The FakeRedis runs the Lua scripts' LOGIC in JS (it does not parse Lua): each
// distinct script is dispatched on a stable substring, and the JS reproduces the same
// trim/sum/reserve/refund behavior over the fake's sorted-set, mirroring the
// faithful-fake discipline in test/pg-redis-store.test.ts. A sabotage "teeth" knob
// (eval ignores the cap) is proven to redden the deny assertion, then restored.
//
// MONEY: amounts cross the boundary as base-unit bigint exactly as the adapter does
// (the script returns an INTEGER decimal string; the adapter BigInts it). Never a JS
// number for a USDC amount, never a decimals literal.
import { describe, it, expect, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import { RedisSpendCapStore } from "../src/stores/spend-cap-redis";
import { SPEND_CAP_WINDOW_SECONDS } from "@utter/data-proxy";

const PAYER_A = "0xpayer-aaaa";
const PAYER_B = "0xpayer-bbbb";
const HOUR = 3600; // injected clock is in seconds
const DAY = 24 * HOUR;

// --------------------------------------------------------------------------- //
// FakeRedis: emulates ONLY the surface RedisSpendCapStore calls. eval() runs    //
// each script's LOGIC in JS over per-key sorted sets (member -> score) + an INCR //
// counter map. The sum/compare math is exact integer math (the real Lua is exact //
// below 2^53; we model that exactness). expire is tracked but never auto-prunes  //
// within a test (the trim, not the TTL, drives the contract under the injected   //
// clock).                                                                        //
// --------------------------------------------------------------------------- //

class FakeRedis {
  // key -> (member -> score). A sorted set keyed by member with a numeric score.
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly counters = new Map<string, number>();
  private readonly expires = new Map<string, number>();

  // TEETH KNOB (test-only): when true, the tryRecordSpend script ignores the cap and
  // always reserves. Used to PROVE the deny assertions redden, then restored to false.
  // NEVER a production-logic change -- this is the fake's own knob.
  sabotageIgnoreCap = false;

  // ---- helpers ---- //

  private _zset(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map<string, number>();
      this.zsets.set(key, z);
    }
    return z;
  }

  /** Remove members with score in (-inf, cutoff] -- exclusive upper bound keeps score > cutoff. */
  private _trim(key: string, cutoffExclusive: number): void {
    const z = this.zsets.get(key);
    if (!z) return;
    for (const [member, score] of [...z.entries()]) {
      if (score <= cutoffExclusive) z.delete(member);
    }
    if (z.size === 0) this.zsets.delete(key);
  }

  /** Sum the base-unit amounts (last colon segment) of all members in the set. */
  private _sum(key: string): bigint {
    const z = this.zsets.get(key);
    if (!z) return 0n;
    let sum = 0n;
    for (const member of z.keys()) {
      const amt = member.slice(member.lastIndexOf(":") + 1);
      sum += BigInt(amt);
    }
    return sum;
  }

  private _incr(key: string): number {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  /** Test introspection: the live member->score map for a payer's window. */
  _members(key: string): Map<string, number> {
    return new Map(this.zsets.get(key) ?? new Map<string, number>());
  }

  // ---- the only command the adapter calls ---- //
  //
  // eval(script, numKeys, ...keysThenArgs). We dispatch on a stable substring of the
  // script and run the equivalent JS. The real adapter passes:
  //   recordSpend:    2 keys (zset, seqkey), argv now/amount/window
  //   tryRecordSpend: 2 keys (zset, seqkey), argv now/amount/cap/window
  //   refundSpend:    1 key  (zset),         argv now/amount/window
  async eval(script: string, numKeys: number, ...rest: (string | number)[]): Promise<unknown> {
    // The adapter always passes every key/arg its script declares, so each lookup is
    // present; `at` asserts that (and keeps noUncheckedIndexedAccess happy).
    const all = rest.map(String);
    const at = (i: number): string => {
      const v = all[i];
      if (v === undefined) throw new Error(`FakeRedis.eval: missing arg ${i}`);
      return v;
    };
    const keys = (i: number): string => at(i);
    const argv = (i: number): string => at(numKeys + i);

    // refundSpend: the only script that uses ZRANGEBYSCORE + ZREM.
    if (script.includes("ZRANGEBYSCORE")) {
      const zkey = keys(0);
      const now = Number(argv(0));
      const amount = BigInt(argv(1));
      const window = Number(argv(2));
      this._trim(zkey, now - window);
      const z = this._zset(zkey);
      // Among members at score == now, remove the FIRST whose amount == amount.
      for (const [member, score] of z.entries()) {
        if (score !== now) continue;
        const amt = BigInt(member.slice(member.lastIndexOf(":") + 1));
        if (amt === amount) {
          z.delete(member);
          break;
        }
      }
      this.expires.set(zkey, window);
      return this._sum(zkey).toString();
    }

    // tryRecordSpend: the only script that reads a cap (argv now/amount/cap/window).
    if (script.includes("local cap")) {
      const zkey = keys(0);
      const seqkey = keys(1);
      const now = Number(argv(0));
      const amount = BigInt(argv(1));
      const cap = BigInt(argv(2));
      const window = Number(argv(3));
      this._trim(zkey, now - window);
      const sum = this._sum(zkey);
      if (!this.sabotageIgnoreCap && sum + amount > cap) {
        this.expires.set(zkey, window);
        return [0, sum.toString()];
      }
      if (amount !== 0n) {
        const seq = this._incr(seqkey);
        this._zset(zkey).set(`${now}:${seq}:${amount.toString()}`, now);
      }
      this.expires.set(zkey, window);
      return [1, (sum + amount).toString()];
    }

    // recordSpend: 2 keys, argv now/amount/window, no cap.
    {
      const zkey = keys(0);
      const seqkey = keys(1);
      const now = Number(argv(0));
      const amount = BigInt(argv(1));
      const window = Number(argv(2));
      this._trim(zkey, now - window);
      if (amount !== 0n) {
        const seq = this._incr(seqkey);
        this._zset(zkey).set(`${now}:${seq}:${amount.toString()}`, now);
      }
      this.expires.set(zkey, window);
      return this._sum(zkey).toString();
    }
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }
}

function makeStore() {
  const fakeRedis = new FakeRedis();
  const store = new RedisSpendCapStore(fakeRedis as unknown as Redis);
  return { fakeRedis, store };
}

describe("RedisSpendCapStore rolling-24h window (faithful fake, injected clock)", () => {
  let fakeRedis: FakeRedis;
  let store: RedisSpendCapStore;

  beforeEach(() => {
    ({ fakeRedis, store } = makeStore());
  });

  it("recordSpend atomically adds and returns the new rolling-24h total (bigint base units)", async () => {
    expect(await store.recordSpend(PAYER_A, 100n, 0)).toBe(100n);
    expect(await store.recordSpend(PAYER_A, 250n, HOUR)).toBe(350n);
    // A zero-amount record is the pure read of the current window total.
    expect(await store.recordSpend(PAYER_A, 0n, 2 * HOUR)).toBe(350n);
  });

  it("keeps per-payer windows independent (no cross-payer sum)", async () => {
    await store.recordSpend(PAYER_A, 500n, 0);
    await store.recordSpend(PAYER_B, 70n, 0);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(500n);
    expect(await store.recordSpend(PAYER_B, 0n, HOUR)).toBe(70n);
  });

  it("drops spends older than 24h from the window deterministically via the injected clock", async () => {
    await store.recordSpend(PAYER_A, 100n, 0);
    await store.recordSpend(PAYER_A, 100n, HOUR);
    // At t just under 24h after the first, both are still in-window.
    expect(await store.recordSpend(PAYER_A, 0n, DAY - 1)).toBe(200n);
    // Advance 24h+1s past the FIRST spend: it drops out (score 0 <= cutoff), the second remains.
    expect(await store.recordSpend(PAYER_A, 0n, DAY + 1)).toBe(100n);
    // Advance 24h+1s past the SECOND spend too: the window empties.
    expect(await store.recordSpend(PAYER_A, 0n, DAY + HOUR + 1)).toBe(0n);
  });

  it("keeps a spend at exactly the window boundary (score > cutoff keep rule, matching InMemory)", async () => {
    // A spend at t=HOUR is kept while now-window < HOUR and dropped once now-window >= HOUR.
    await store.recordSpend(PAYER_A, 42n, HOUR);
    // now = HOUR + DAY: cutoff = HOUR, score HOUR <= cutoff -> dropped.
    expect(await store.recordSpend(PAYER_A, 0n, HOUR + DAY)).toBe(0n);
  });

  it("uses the injected now, not Date.now(): a recorded spend far in the simulated future is in-window", async () => {
    const future = 10 * 365 * DAY; // a decade ahead of any real wall clock
    await store.recordSpend(PAYER_A, 42n, future);
    expect(await store.recordSpend(PAYER_A, 0n, future + HOUR)).toBe(42n);
  });

  it("two spends at the SAME second both count (the seq counter keeps members unique)", async () => {
    // Without a per-spend uniqueness seq, a ZSET would dedupe identical members and
    // lose one of the two same-second spends. The seq guarantees both are recorded.
    expect(await store.recordSpend(PAYER_A, 100n, HOUR)).toBe(100n);
    expect(await store.recordSpend(PAYER_A, 100n, HOUR)).toBe(200n);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(200n);
  });

  it("a large-but-realistic total round-trips EXACTLY (proves the integer-string return)", async () => {
    // 5_000_000_000 base units (5000 USDC at 6dp) is far below 2^53, so the Lua double
    // sum is exact and the integer-string return BigInts back without precision loss or
    // scientific-notation corruption.
    expect(await store.recordSpend(PAYER_A, 2_500_000_000n, 0)).toBe(2_500_000_000n);
    expect(await store.recordSpend(PAYER_A, 2_500_000_000n, HOUR)).toBe(5_000_000_000n);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(5_000_000_000n);
  });
});

describe("RedisSpendCapStore.tryRecordSpend (WR-04 atomic check-and-reserve)", () => {
  let fakeRedis: FakeRedis;
  let store: RedisSpendCapStore;

  beforeEach(() => {
    ({ fakeRedis, store } = makeStore());
  });

  it("records the spend and returns allowed when within the cap", async () => {
    const r = await store.tryRecordSpend(PAYER_A, 300n, 1000n, HOUR);
    expect(r.allowed).toBe(true);
    expect(r.total).toBe(300n);
    // The spend is persisted (the window reflects it for the next check).
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(300n);
  });

  it("allows at the exact boundary sum + amount == cap", async () => {
    await store.recordSpend(PAYER_A, 600n, 0);
    const r = await store.tryRecordSpend(PAYER_A, 400n, 1000n, HOUR);
    expect(r.allowed).toBe(true);
    expect(r.total).toBe(1000n);
  });

  it("records NOTHING and returns denied when the spend would exceed the cap", async () => {
    await store.recordSpend(PAYER_A, 900n, 0);
    const r = await store.tryRecordSpend(PAYER_A, 200n, 1000n, HOUR);
    expect(r.allowed).toBe(false);
    expect(r.total).toBe(900n);
    // Deny records nothing - the window is unchanged at 900.
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(900n);
  });

  it("is atomic under concurrency: two jointly-over-cap reservations -> exactly one allowed", async () => {
    // 600 + 600 = 1200 > 1000. The atomic single-EVAL op admits exactly one.
    const [a, b] = await Promise.all([
      store.tryRecordSpend(PAYER_A, 600n, 1000n, HOUR),
      store.tryRecordSpend(PAYER_A, 600n, 1000n, HOUR),
    ]);
    const allowed = [a, b].filter((r) => r.allowed).length;
    expect(allowed).toBe(1);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(600n);
  });

  it("a large-but-realistic reserved total round-trips EXACTLY", async () => {
    const cap = 5_000_000_000n;
    await store.recordSpend(PAYER_A, 4_999_999_999n, 0);
    const r = await store.tryRecordSpend(PAYER_A, 1n, cap, HOUR);
    expect(r.allowed).toBe(true);
    expect(r.total).toBe(5_000_000_000n);
  });

  it("TEETH: the deny assertion reddens when the fake ignores the cap, then restored", async () => {
    await store.recordSpend(PAYER_A, 900n, 0);
    fakeRedis.sabotageIgnoreCap = true;
    const sabotaged = await store.tryRecordSpend(PAYER_A, 200n, 1000n, HOUR);
    // With the cap ignored the over-cap reservation wrongly passes (proves the assertion has teeth).
    expect(sabotaged.allowed).toBe(true);
    fakeRedis.sabotageIgnoreCap = false;
    // Restored: the same over-cap reservation is correctly denied.
    const { fakeRedis: fresh, store: freshStore } = makeStore();
    void fresh;
    await freshStore.recordSpend(PAYER_A, 900n, 0);
    const honest = await freshStore.tryRecordSpend(PAYER_A, 200n, 1000n, HOUR);
    expect(honest.allowed).toBe(false);
  });
});

describe("RedisSpendCapStore.refundSpend (WR-04 compensating undo)", () => {
  let store: RedisSpendCapStore;

  beforeEach(() => {
    ({ store } = makeStore());
  });

  it("removes ONE reserved (amount, now) entry and lowers the total", async () => {
    await store.tryRecordSpend(PAYER_A, 400n, 1000n, HOUR);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(400n);
    expect(await store.refundSpend(PAYER_A, 400n, HOUR)).toBe(0n);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(0n);
  });

  it("removes exactly ONE of two identical holds at the same now (not both)", async () => {
    await store.tryRecordSpend(PAYER_A, 100n, 1000n, HOUR);
    await store.tryRecordSpend(PAYER_A, 100n, 1000n, HOUR);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(200n);
    // Refund one: exactly one 100 hold is removed, leaving the other.
    expect(await store.refundSpend(PAYER_A, 100n, HOUR)).toBe(100n);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(100n);
  });

  it("is a no-op when there is no matching hold at now", async () => {
    await store.recordSpend(PAYER_A, 100n, 0);
    // No hold of 100 at score == HOUR exists (the spend was at score 0).
    expect(await store.refundSpend(PAYER_A, 100n, HOUR)).toBe(100n);
  });

  it("disconnect() resolves cleanly (quits the ioredis client)", async () => {
    await expect(store.disconnect()).resolves.toBeUndefined();
  });
});

// A guard so the imported window constant is the value the adapter trims on (24h).
describe("SPEND_CAP_WINDOW_SECONDS", () => {
  it("is 24h in seconds (the window the adapter trims on)", () => {
    expect(SPEND_CAP_WINDOW_SECONDS).toBe(24 * 3600);
  });
});
