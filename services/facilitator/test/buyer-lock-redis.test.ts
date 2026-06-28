// Behavioral conformance suite for the REAL Redis-backed PerBuyerLock adapter
// (services/facilitator/src/stores/buyer-lock-redis.ts -- RedisBuyerLock), run fully
// OFFLINE against a hand-rolled faithful fake of the exact ioredis.Redis command
// surface the adapter calls. No real Redis, no Docker, no real sleeping, no new npm
// dependency.
//
// This proves the Redis adapter honors the SAME PerBuyerLock contract the in-memory
// adapter satisfies in verify.ts (createInMemoryBuyerLock): same-buyer fn() calls are
// strictly serialized, different buyers run concurrently, runExclusive returns fn()'s
// value, propagates its rejection, and releases the lock on both success and throw.
// It additionally proves the durable-lock-specific guarantees the in-memory version
// gets for free: case-insensitive keying, compare-and-delete release (a stale holder
// cannot delete a later holder's lock), crashed-holder auto-release via TTL, and the
// MUST-NOT-SILENTLY-DEGRADE rule -- an acquire timeout FAILS CLOSED (throws and never
// invokes fn()).
//
// CLOCK + SLEEP: the adapter reads Date.now() only for the acquire deadline and calls
// an injected sleep between retries. The suite drives a FAKE clock and stubs sleep so
// it advances that clock instead of waiting -- fully deterministic, no real timers.
// The FakeRedis honors PX TTL against the SAME fake clock so an expired key is gone on
// the next access (the crashed-holder auto-release path).
//
// The FakeRedis runs the release Lua's LOGIC in JS (it does not parse Lua): the only
// eval the adapter issues is the compare-and-delete, dispatched on a stable substring.
import { describe, it, expect } from "vitest";
import type { Redis } from "ioredis";
import { RedisBuyerLock } from "../src/stores/buyer-lock-redis";
import { createInMemoryBuyerLock } from "../src/verify";
import { resolveBuyerLock } from "../src/server";
import type { Hex } from "viem";

// --------------------------------------------------------------------------- //
// A controllable clock: now() returns the fake time; advance(ms) moves it. The   //
// adapter's Date.now() is monkey-patched onto this in makeLock so the acquire     //
// deadline and the FakeRedis PX TTL share one deterministic timeline.            //
// --------------------------------------------------------------------------- //

class FakeClock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// --------------------------------------------------------------------------- //
// FakeRedis: emulates ONLY the surface RedisBuyerLock calls --                    //
//   set(key, token, "PX", ttlMs, "NX") -> "OK" when the key is free, null when    //
//     a live (un-expired against the fake clock) key already exists;              //
//   eval(RELEASE_LUA, 1, key, token)   -> GET==token ? DEL,1 : 0;                 //
//   quit() -> "OK".                                                               //
// A key carries its expiry (absolute fake-clock ms). On any access an expired key //
// is treated as absent (this is the crashed-holder auto-release).                 //
// --------------------------------------------------------------------------- //

class FakeRedis {
  private readonly store = new Map<string, { token: string; expiresAt: number }>();
  private readonly clock: FakeClock;

  // TEETH KNOB (test-only): when true the release eval ignores the token and always
  // deletes the key (an unconditional DEL). Used to PROVE the compare-and-delete
  // assertion reddens, then restored. NEVER a production-logic change.
  sabotageReleaseIgnoresToken = false;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  /** Return the live entry for key, pruning it first if its PX TTL has elapsed. */
  private live(key: string): { token: string; expiresAt: number } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  // ioredis: set(key, value, "PX", ttlMs, "NX"). Returns "OK" on a successful set,
  // null when NX fails (a live key exists). The adapter only ever calls this form.
  async set(
    key: string,
    value: string,
    px: "PX",
    ttlMs: number,
    nx: "NX",
  ): Promise<"OK" | null> {
    if (px !== "PX" || nx !== "NX") {
      throw new Error("FakeRedis.set: unexpected option flags");
    }
    if (this.live(key)) return null; // NX: a live key blocks the set
    this.store.set(key, { token: value, expiresAt: this.clock.now() + ttlMs });
    return "OK";
  }

  // ioredis: eval(script, numKeys, ...keysThenArgs). Only the compare-and-delete
  // release script is issued: eval(RELEASE_LUA, 1, key, token).
  async eval(script: string, numKeys: number, ...rest: (string | number)[]): Promise<unknown> {
    if (!script.includes("redis.call('DEL'")) {
      throw new Error("FakeRedis.eval: unexpected script");
    }
    void numKeys;
    const key = String(rest[0]);
    const token = String(rest[1]);
    const e = this.live(key);
    if (this.sabotageReleaseIgnoresToken) {
      // Sabotage: unconditional delete regardless of token (the bug the teeth catch).
      const existed = e !== undefined;
      this.store.delete(key);
      return existed ? 1 : 0;
    }
    if (e && e.token === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  /** Test introspection: the live holder token for a key (or undefined). */
  holder(key: string): string | undefined {
    return this.live(key)?.token;
  }
}

// Build a lock whose Date.now() and sleep are bound to the fake clock. sleep does NOT
// wait; it advances the fake clock by the requested ms so the acquire deadline and any
// PX TTL progress deterministically without real timers.
function makeLock(opts?: {
  lockTtlMs?: number;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
}) {
  const clock = new FakeClock();
  const fakeRedis = new FakeRedis(clock);
  const sleep = async (ms: number): Promise<void> => {
    clock.advance(ms);
  };
  const realDateNow = Date.now;
  // Bind Date.now to the fake clock for the lifetime of the lock under test. Restored
  // by restoreClock() in a finally so no global leak crosses tests.
  Date.now = () => clock.now();
  const lock = new RedisBuyerLock(fakeRedis as unknown as Redis, {
    lockTtlMs: opts?.lockTtlMs ?? 10_000,
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? 5_000,
    retryDelayMs: opts?.retryDelayMs ?? 30,
    sleep,
  });
  const restoreClock = () => {
    Date.now = realDateNow;
  };
  return { clock, fakeRedis, lock, restoreClock };
}

const BUYER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const BUYER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const KEY_A = "buyerlock:" + BUYER_A.toLowerCase();

// A controllable async barrier: a promise plus its resolver, so a test can hold one
// fn() open until it chooses to let it settle.
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("RedisBuyerLock serialization (faithful fake, controllable clock)", () => {
  it("serializes the SAME buyer: a second fn does not start until the first settles", async () => {
    const { lock, restoreClock } = makeLock();
    try {
      const order: string[] = [];
      const gate1 = deferred();

      const p1 = lock.runExclusive(BUYER_A, async () => {
        order.push("1-start");
        await gate1.promise;
        order.push("1-end");
        return "first";
      });

      // Let p1 acquire and park inside fn() before we launch p2.
      await Promise.resolve();
      await Promise.resolve();

      const p2 = lock.runExclusive(BUYER_A, async () => {
        order.push("2-start");
        return "second";
      });

      // Pump microtasks: p2 must NOT have started while p1 holds the lock. It spins on
      // the NX set (each retry advances the fake clock via the stubbed sleep), but the
      // key is still live, so fn() #2 never runs yet.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(order).toEqual(["1-start"]);

      // Release p1; now p2 may acquire and run.
      gate1.resolve();
      expect(await p1).toBe("first");
      expect(await p2).toBe("second");
      expect(order).toEqual(["1-start", "1-end", "2-start"]);
    } finally {
      restoreClock();
    }
  });

  it("runs DIFFERENT buyers concurrently (both in-flight at once)", async () => {
    const { lock, restoreClock } = makeLock();
    try {
      const aIn = deferred();
      const bIn = deferred();
      const release = deferred();

      const pa = lock.runExclusive(BUYER_A, async () => {
        aIn.resolve();
        await release.promise;
        return "a";
      });
      const pb = lock.runExclusive(BUYER_B, async () => {
        bIn.resolve();
        await release.promise;
        return "b";
      });

      // Both fn()s reach their barrier without either releasing -> truly concurrent.
      await Promise.all([aIn.promise, bIn.promise]);
      release.resolve();
      expect(await Promise.all([pa, pb])).toEqual(["a", "b"]);
    } finally {
      restoreClock();
    }
  });

  it("serializes a buyer case-insensitively (0xABC... and 0xabc... share one key)", async () => {
    const { lock, restoreClock } = makeLock();
    try {
      const upper = BUYER_A.toUpperCase().replace("0X", "0x") as Hex; // 0xAAAA...
      const order: string[] = [];
      const gate = deferred();

      const p1 = lock.runExclusive(upper, async () => {
        order.push("upper-start");
        await gate.promise;
        order.push("upper-end");
      });
      await Promise.resolve();
      await Promise.resolve();

      const p2 = lock.runExclusive(BUYER_A, async () => {
        order.push("lower-start");
      });
      for (let i = 0; i < 50; i++) await Promise.resolve();
      // Same lowercased key -> the lower-case call waits for the upper-case holder.
      expect(order).toEqual(["upper-start"]);

      gate.resolve();
      await Promise.all([p1, p2]);
      expect(order).toEqual(["upper-start", "upper-end", "lower-start"]);
    } finally {
      restoreClock();
    }
  });
});

describe("RedisBuyerLock value + rejection propagation + release-on-throw", () => {
  it("returns fn's value", async () => {
    const { lock, restoreClock } = makeLock();
    try {
      expect(await lock.runExclusive(BUYER_A, async () => 42)).toBe(42);
    } finally {
      restoreClock();
    }
  });

  it("propagates fn's rejection AND releases the lock so the next same-buyer acquires", async () => {
    const { lock, fakeRedis, restoreClock } = makeLock();
    try {
      await expect(
        lock.runExclusive(BUYER_A, async () => {
          throw new Error("handler boom");
        }),
      ).rejects.toThrow("handler boom");

      // The finally compare-and-delete fired on the throw: the key is released.
      expect(fakeRedis.holder(KEY_A)).toBeUndefined();

      // The next same-buyer call acquires immediately and runs.
      expect(await lock.runExclusive(BUYER_A, async () => "after")).toBe("after");
    } finally {
      restoreClock();
    }
  });
});

describe("RedisBuyerLock compare-and-delete release (sabotage teeth)", () => {
  it("a stale holder must NOT delete a later holder's lock; teeth proven then restored", async () => {
    // Drive the raw acquire/release primitives via the fake so we can interleave a
    // stale release against a fresh holder deterministically.
    const clock = new FakeClock();
    const fakeRedis = new FakeRedis(clock);

    // Holder 1 acquires with a short TTL, then its TTL expires.
    const r1 = await fakeRedis.set(KEY_A, "token-1", "PX", 1000, "NX");
    expect(r1).toBe("OK");
    clock.advance(1500); // holder-1's lock has now auto-expired

    // Holder 2 acquires the (now free) key.
    const r2 = await fakeRedis.set(KEY_A, "token-2", "PX", 1000, "NX");
    expect(r2).toBe("OK");
    expect(fakeRedis.holder(KEY_A)).toBe("token-2");

    // Holder 1's late compare-and-delete release must be a no-op (token mismatch):
    // holder-2's lock survives.
    const releaseLua =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
    const honest = await fakeRedis.eval(releaseLua, 1, KEY_A, "token-1");
    expect(honest).toBe(0);
    expect(fakeRedis.holder(KEY_A)).toBe("token-2"); // intact

    // TEETH: with the compare ignored (unconditional DEL) holder-1's release WOULD
    // wrongly delete holder-2's lock -- proving the assertion above has bite.
    fakeRedis.sabotageReleaseIgnoresToken = true;
    const sabotaged = await fakeRedis.eval(releaseLua, 1, KEY_A, "token-1");
    expect(sabotaged).toBe(1); // it deleted SOMETHING (holder-2's lock)
    expect(fakeRedis.holder(KEY_A)).toBeUndefined(); // holder-2 wrongly evicted
    fakeRedis.sabotageReleaseIgnoresToken = false; // restore
  });
});

describe("RedisBuyerLock crashed-holder auto-release (TTL)", () => {
  it("a holder that never releases auto-expires; the next acquire then succeeds", async () => {
    const { clock, fakeRedis, restoreClock } = makeLock({ lockTtlMs: 2000 });
    try {
      // Simulate a crashed holder: its key is set but never released.
      await fakeRedis.set(KEY_A, "ghost", "PX", 2000, "NX");
      expect(fakeRedis.holder(KEY_A)).toBe("ghost");

      // Advance past the TTL: the ghost key auto-expires.
      clock.advance(2500);
      expect(fakeRedis.holder(KEY_A)).toBeUndefined();

      // A real runExclusive now acquires on the first try and runs fn().
      let ran = false;
      const out = await new RedisBuyerLock(fakeRedis as unknown as Redis, {
        lockTtlMs: 2000,
        acquireTimeoutMs: 5000,
        retryDelayMs: 30,
        sleep: async (ms) => clock.advance(ms),
      }).runExclusive(BUYER_A, async () => {
        ran = true;
        return "ok";
      });
      expect(ran).toBe(true);
      expect(out).toBe("ok");
    } finally {
      restoreClock();
    }
  });
});

describe("RedisBuyerLock acquire-timeout FAILS CLOSED (must not silently degrade)", () => {
  it("when the lock is held past the acquire timeout the waiter THROWS and fn() is NEVER invoked", async () => {
    // A long-lived foreign holder (TTL >> acquireTimeout) so the key never frees while
    // the waiter spins. Each retry advances the fake clock via the stubbed sleep, so
    // the acquire deadline is crossed deterministically with no real waiting.
    const { fakeRedis, lock, restoreClock } = makeLock({
      lockTtlMs: 1_000_000,
      acquireTimeoutMs: 200,
      retryDelayMs: 30,
    });
    try {
      await fakeRedis.set(KEY_A, "foreign-holder", "PX", 1_000_000, "NX");

      let fnInvoked = false;
      await expect(
        lock.runExclusive(BUYER_A, async () => {
          fnInvoked = true; // the critical assertion: this must NEVER run
          return "should-not-happen";
        }),
      ).rejects.toThrow();

      // FAIL CLOSED: the reserve critical section never ran unguarded.
      expect(fnInvoked).toBe(false);
      // The foreign holder's lock is untouched (no stale release stole it).
      expect(fakeRedis.holder(KEY_A)).toBe("foreign-holder");
    } finally {
      restoreClock();
    }
  });

  it("the acquire-timeout error is value-free (names no buyer, echoes no token)", async () => {
    const { fakeRedis, lock, restoreClock } = makeLock({
      lockTtlMs: 1_000_000,
      acquireTimeoutMs: 100,
      retryDelayMs: 30,
    });
    try {
      await fakeRedis.set(KEY_A, "secret-token-value", "PX", 1_000_000, "NX");
      let message = "";
      try {
        await lock.runExclusive(BUYER_A, async () => "x");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("secret-token-value");
      expect(message.toLowerCase()).not.toContain(BUYER_A.toLowerCase());
    } finally {
      restoreClock();
    }
  });
});

describe("RedisBuyerLock token uniqueness + disconnect", () => {
  it("uses a UNIQUE token across sequential acquisitions of the same buyer", async () => {
    const { fakeRedis, lock, restoreClock } = makeLock();
    try {
      const tokens: string[] = [];
      // Capture the token written on each acquire by snapshotting the holder inside fn().
      await lock.runExclusive(BUYER_A, async () => {
        tokens.push(fakeRedis.holder(KEY_A) as string);
      });
      await lock.runExclusive(BUYER_A, async () => {
        tokens.push(fakeRedis.holder(KEY_A) as string);
      });
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]); // a fresh crypto.randomUUID each time
    } finally {
      restoreClock();
    }
  });

  it("disconnect() resolves cleanly (quits the ioredis client)", async () => {
    const { lock, restoreClock } = makeLock();
    try {
      await expect(lock.disconnect()).resolves.toBeUndefined();
    } finally {
      restoreClock();
    }
  });
});

describe("resolveBuyerLock env-matrix (pass an env object; never mutate process.env)", () => {
  it("REDIS_URL set -> a Redis-backed PerBuyerLock (duck-typed; no real connection used)", () => {
    const lock = resolveBuyerLock({ REDIS_URL: "redis://localhost:6379" } as NodeJS.ProcessEnv);
    expect(typeof lock.runExclusive).toBe("function");
    expect(lock).toBeInstanceOf(RedisBuyerLock);
  });

  it("no REDIS_URL + NODE_ENV=production -> THROWS a value-free error (no url in the message)", () => {
    const url = "redis://super-secret-host:6379/7";
    expect(() => resolveBuyerLock({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /REDIS_URL/,
    );
    // Sanity: even if a url were somehow present we never echo a value -- assert the
    // message mentions the VAR NAME, not any url value.
    try {
      resolveBuyerLock({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).not.toContain(url);
      expect((e as Error).message).not.toContain("redis://");
    }
  });

  it("no REDIS_URL + dev -> the in-memory lock (serializes like createInMemoryBuyerLock)", async () => {
    const lock = resolveBuyerLock({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(lock).not.toBeInstanceOf(RedisBuyerLock);

    // It still serializes same-buyer work (the in-memory contract).
    const order: string[] = [];
    const gate = deferred();
    const p1 = lock.runExclusive(BUYER_A, async () => {
      order.push("1-start");
      await gate.promise;
      order.push("1-end");
    });
    await Promise.resolve();
    const p2 = lock.runExclusive(BUYER_A, async () => {
      order.push("2-start");
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(["1-start"]);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
  });

  it("a bare in-memory baseline (createInMemoryBuyerLock) shares the dev resolver's contract", async () => {
    const lock = createInMemoryBuyerLock();
    expect(await lock.runExclusive(BUYER_A, async () => "ok")).toBe("ok");
  });
});
