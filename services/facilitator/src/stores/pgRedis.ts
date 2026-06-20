// The real Postgres + Redis store adapter (PAY-09, PAY-11).
//
// HONESTY FLAG: this adapter ships BEHAVIOR-UNVERIFIED in Phase 2. It is
// type-checked and conforms to the shared `PaymentStore` / `ResultStore` interface
// (the same contract the in-memory adapter satisfies and the full default test
// suite exercises), but its LIVE behavior against a real Postgres/Redis is verified
// only when those services are provisioned (Phase 3+ infra). The default test run
// uses the in-memory adapter and does NOT require Docker/pg/Redis. Do not treat
// this as production-ready.
//
// Split of responsibilities (per SPEC §11 + CONTEXT):
//   - Postgres (`pg.Pool`): durable `payments` + `results` tables (parameterized
//     queries only; never string-concatenated SQL).
//   - Redis (`ioredis`): the reservation lock (`SET key val NX PX ttl` so a
//     concurrent verify cannot double-reserve) + a spent-nonce set + the per-buyer
//     outstanding-reservation accounting + the per-resource strike counter.
//
// All amounts are USDC base units stored as text/numeric and parsed back to bigint
// at the boundary - never a JS number (no precision loss), never a decimals literal.
import { Pool } from "pg";
import { Redis } from "ioredis";
import type { Hex } from "viem";
import {
  type PaymentStore,
  type ResultStore,
  type ReservationLock,
  type StoredResult,
  DEFAULT_RESULT_TTL_SECONDS,
} from "@utter/x402-arc";
import type { FacilitatorStores } from "./memory";

const RES_PREFIX = "resv:"; // reservation lock key prefix
const RES_BUYER_PREFIX = "resvbuyer:"; // per-buyer live-reservation set
const SPENT_PREFIX = "spent:"; // spent-nonce membership key prefix
const STRIKE_PREFIX = "strike:"; // per-resource strike counter key prefix

/** Postgres-backed PaymentStore with Redis reservation locks + spent-nonce cache. */
export class PgRedisPaymentStore implements PaymentStore {
  constructor(
    private readonly pg: Pool,
    private readonly redis: Redis,
  ) {}

  async reserve(lock: ReservationLock): Promise<boolean> {
    // Spent nonces can never be re-reserved (the on-chain usedNonce is the final
    // authority; this is the off-chain short-circuit).
    if ((await this.redis.exists(`${SPENT_PREFIX}${lock.idemKey}`)) === 1) {
      return false;
    }
    const ttlMs = Math.max(1, lock.expiresAt - Date.now());
    // Atomic reserve: SET NX only sets when the key is absent, so a concurrent or
    // replayed verify for the same nonce loses the race and returns false.
    const ok = await this.redis.set(
      `${RES_PREFIX}${lock.idemKey}`,
      JSON.stringify({ buyer: lock.buyer, cap: lock.cap.toString(), resourceId: lock.resourceId }),
      "PX",
      ttlMs,
      "NX",
    );
    if (ok !== "OK") return false;
    // Track the live reservation under the buyer for outstandingReserved, with the
    // same TTL so it self-expires (the member is the idemKey; the value is the cap).
    await this.redis.set(
      `${RES_BUYER_PREFIX}${lock.buyer.toLowerCase()}:${lock.idemKey}`,
      lock.cap.toString(),
      "PX",
      ttlMs,
    );
    // Durable record for ops/audit (the lock is the authority; this is the ledger row).
    await this.pg.query(
      `INSERT INTO payments (idem_key, buyer, resource_id, cap, status, created_at)
       VALUES ($1, $2, $3, $4, 'reserved', now())
       ON CONFLICT (idem_key) DO UPDATE SET status = 'reserved'`,
      [lock.idemKey, lock.buyer, lock.resourceId, lock.cap.toString()],
    );
    return true;
  }

  async release(idemKey: Hex): Promise<void> {
    await this.redis.del(`${RES_PREFIX}${idemKey}`);
    // Drop any buyer-set members for this idemKey (scan by suffix).
    const keys = await this.redis.keys(`${RES_BUYER_PREFIX}*:${idemKey}`);
    if (keys.length > 0) await this.redis.del(...keys);
    await this.pg.query(`UPDATE payments SET status = 'released' WHERE idem_key = $1`, [idemKey]);
  }

  async markNonceSpent(idemKey: Hex): Promise<void> {
    // Permanent spent marker (no TTL) - a settled nonce can never be re-reserved.
    await this.redis.set(`${SPENT_PREFIX}${idemKey}`, "1");
    await this.redis.del(`${RES_PREFIX}${idemKey}`);
    const keys = await this.redis.keys(`${RES_BUYER_PREFIX}*:${idemKey}`);
    if (keys.length > 0) await this.redis.del(...keys);
    await this.pg.query(`UPDATE payments SET status = 'settled' WHERE idem_key = $1`, [idemKey]);
  }

  async isNoncePending(idemKey: Hex): Promise<boolean> {
    return (await this.redis.exists(`${RES_PREFIX}${idemKey}`)) === 1;
  }

  async outstandingReserved(buyer: Hex): Promise<bigint> {
    // Sum the live (unexpired) reservation caps for this buyer. The Redis TTL prunes
    // expired members for us, so a stale lock never inflates the outstanding sum.
    const keys = await this.redis.keys(`${RES_BUYER_PREFIX}${buyer.toLowerCase()}:*`);
    if (keys.length === 0) return 0n;
    const values = await this.redis.mget(...keys);
    let sum = 0n;
    for (const v of values) {
      if (v) sum += BigInt(v);
    }
    return sum;
  }

  async recordStrike(resourceId: Hex, _reason: string): Promise<void> {
    await this.redis.incr(`${STRIKE_PREFIX}${resourceId.toLowerCase()}`);
  }

  async getStrikes(resourceId: Hex): Promise<number> {
    const v = await this.redis.get(`${STRIKE_PREFIX}${resourceId.toLowerCase()}`);
    return v ? Number(v) : 0;
  }
}

/** Postgres-backed ResultStore (durable persisted settle results; TTL-pruned). */
export class PgRedisResultStore implements ResultStore {
  constructor(private readonly pg: Pool) {}

  async get(idemKey: Hex): Promise<StoredResult | null> {
    const { rows } = await this.pg.query<{
      idem_key: Hex;
      response: string;
      receipt: unknown;
      stored_at: string;
      expires_at: string;
    }>(
      `SELECT idem_key, response, receipt, stored_at, expires_at
       FROM results WHERE idem_key = $1`,
      [idemKey],
    );
    const row = rows[0];
    if (!row) return null;
    // TTL check: an expired row is treated as absent (the GET /results 404 path).
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return {
      idemKey: row.idem_key,
      response: row.response,
      receipt: row.receipt,
      storedAt: new Date(row.stored_at).getTime(),
    };
  }

  async put(result: StoredResult, ttlSeconds: number = DEFAULT_RESULT_TTL_SECONDS): Promise<void> {
    const expiresAt = new Date(result.storedAt + ttlSeconds * 1000).toISOString();
    // Idempotent upsert: a retried settle persists the SAME row (the receipt is
    // already keyed on the nonce, so a re-put is a no-op overwrite of identical data).
    await this.pg.query(
      `INSERT INTO results (idem_key, response, receipt, stored_at, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)
       ON CONFLICT (idem_key) DO NOTHING`,
      [result.idemKey, result.response, JSON.stringify(result.receipt), result.storedAt, expiresAt],
    );
  }
}

/** Options for wiring the pg+redis stores from env (DATABASE_URL / REDIS_URL). */
export interface PgRedisOptions {
  databaseUrl: string;
  redisUrl: string;
}

/**
 * Build the real pg+redis facilitator stores. Exposes the same `FacilitatorStores`
 * shape as `createInMemoryStores`, so `server.ts` swaps adapters by env without
 * touching the route logic. Behavior-unverified in Phase 2 (see file header).
 */
export function createPgRedisStores(opts: PgRedisOptions): FacilitatorStores {
  const pg = new Pool({ connectionString: opts.databaseUrl });
  const redis = new Redis(opts.redisUrl);
  return {
    payments: new PgRedisPaymentStore(pg, redis),
    results: new PgRedisResultStore(pg),
  };
}
