// The real Redis-backed PerBuyerLock adapter (Provisioning track, subtask 2).
//
// This is the durable, cross-replica equivalent of createInMemoryBuyerLock in
// verify.ts. It honors the IDENTICAL PerBuyerLock contract: runExclusive(buyer, fn)
// serializes every fn() for the SAME buyer, runs DIFFERENT buyers concurrently,
// returns fn()'s value, and propagates fn()'s rejection. verify.ts and app.ts
// consume the existing PerBuyerLock type unchanged; this adapter is selected by the
// same prod-fail-closed env switch as the other facilitator stores.
//
// SCOPE: this lock spans ONLY the /verify critical section (the balanceOf read +
// outstandingReserved sum + nonce check + store.reserve inside verifyAndReserve),
// whose TTL is ~10s, NOT the much longer reservation TTL. It is fail-safe: a crashed
// holder's key auto-expires after lockTtlMs so the lock is never permanently stuck.
// It is NOT re-entrant; runExclusive is never nested for one buyer in one /verify
// call, so a single non-recursive acquire suffices.
//
// SERIALIZE, DON'T REJECT: a contended acquire BLOCKS and retries (verify.ts has no
// acquire-failure branch, so a thrown lock error on mere contention would surface as
// an uncaught /verify 500). The lock throws ONLY on acquire-TIMEOUT, and that FAILS
// CLOSED: it never runs fn() unguarded, because running the critical section without
// the lock reopens the off-chain double-reserve (free-compute) race. A failed acquire
// can at worst cause a conservative reject, never an overspend (the on-chain debit
// revert remains the sole final authority).
//
// HONESTY FLAG: the command logic here is verified by a faithful-fake conformance
// suite (services/facilitator/test/buyer-lock-redis.test.ts) that EXECUTES
// RedisBuyerLock offline against a hand-rolled ioredis.Redis fake with a controllable
// clock and a stubbed sleep. It is logic-verified, not yet live-infra-verified; the
// live cross-replica proof is operator-gated (real Redis behind REDIS_URL).
//
// MONEY: there is NO decimals/amount literal in this adapter. Date.now() is used ONLY
// for the acquire-timeout deadline, never for a settlement amount.
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Hex } from "viem";
import type { PerBuyerLock } from "../verify";

const KEY_PREFIX = "buyerlock:"; // one key per buyer, lowercased

// Compare-and-delete release: delete the key ONLY if it still holds OUR token, so a
// holder whose TTL already expired (and whose key a later holder re-acquired) can
// never delete the new holder's lock. Atomic single server-side EVAL.
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** Tunables for the lock's TTL, acquire deadline, and retry spacing. */
export interface RedisBuyerLockOptions {
  /** The lock key TTL in ms (the critical-section duration, fail-safe auto-release). */
  lockTtlMs?: number;
  /** The max time in ms to spin waiting for the lock before failing closed (throw). */
  acquireTimeoutMs?: number;
  /** The base delay in ms between acquire retries (jittered). */
  retryDelayMs?: number;
  /** Sleep injection point (test seam): defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Redis-backed PerBuyerLock over an injected ioredis client. Acquire is a single
 * atomic `SET key token NX PX ttl`; release is the compare-and-delete Lua in a
 * finally so it fires on success OR throw. The per-acquire token is a unique
 * crypto.randomUUID so a holder only ever releases its own lock.
 */
export class RedisBuyerLock implements PerBuyerLock {
  private readonly redis: Redis;
  private readonly lockTtlMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(redis: Redis, opts: RedisBuyerLockOptions = {}) {
    this.redis = redis;
    this.lockTtlMs = opts.lockTtlMs ?? 10_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 5_000;
    this.retryDelayMs = opts.retryDelayMs ?? 30;
    this.sleep = opts.sleep ?? realSleep;
  }

  async runExclusive<T>(buyer: Hex, fn: () => Promise<T>): Promise<T> {
    const key = KEY_PREFIX + buyer.toLowerCase();
    // A unique per-call token: only the holder that wrote this token may delete it.
    const token = randomUUID();
    const start = Date.now();

    // Spin until the atomic NX acquire wins. On contention BLOCK and retry; throw
    // (fail closed) only when the acquire deadline elapses.
    while ((await this.redis.set(key, token, "PX", this.lockTtlMs, "NX")) !== "OK") {
      if (Date.now() - start > this.acquireTimeoutMs) {
        // VALUE-FREE: name no buyer, echo no token/url. Fail CLOSED rather than run
        // fn() without the lock (which would reopen the double-reserve race).
        throw new Error(
          "could not acquire the per-buyer verify lock within the acquire timeout; " +
            "failing closed rather than running the reserve critical section unguarded",
        );
      }
      // Jitter the retry delay to avoid a synchronized retry thundering herd.
      await this.sleep(Math.floor(this.retryDelayMs * (0.5 + Math.random())));
    }

    try {
      return await fn();
    } finally {
      // Compare-and-delete: release the lock only if it still holds OUR token. If our
      // TTL already expired and a later holder owns the key, this deletes nothing.
      await this.redis.eval(RELEASE_LUA, 1, key, token);
    }
  }

  /** Quit the ioredis client (clean teardown for tests + operator shutdown). */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Build a Redis-backed PerBuyerLock from a connection URL (mirrors
 * createRedisSpendCapStore). The URL is never logged. Returns the lock typed as the
 * shared PerBuyerLock contract so server.ts swaps adapters by env without touching
 * verify.ts. Behavior is logic-verified offline (see the file header), not yet
 * live-infra-verified.
 */
export function createRedisBuyerLock(redisUrl: string): PerBuyerLock {
  return new RedisBuyerLock(new Redis(redisUrl));
}
