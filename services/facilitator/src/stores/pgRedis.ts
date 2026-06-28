// The real Postgres + Redis store adapter (PAY-09, PAY-11).
//
// HONESTY FLAG: this adapter's COMMAND LOGIC is now verified by a faithful-fake
// conformance suite (services/facilitator/test/pg-redis-store.test.ts) that EXECUTES
// PgRedisPaymentStore + PgRedisResultStore offline against hand-rolled pg.Pool /
// ioredis.Redis fakes, asserting the same `PaymentStore` / `ResultStore` contract the
// in-memory adapter satisfies: SET NX no-double-reserve, MULTI atomicity in
// markNonceSpent, per-buyer outstanding accounting with lazy TTL prune, settle-tx
// first-write-wins, and pg INSERT...ON CONFLICT idempotency. That suite runs in the
// default test run and needs no Docker/pg/Redis. It is STILL NOT verified against
// LIVE Postgres/Redis; live behavior is confirmed only when those services are
// provisioned (operator-gated Phase 3+ infra). Logic-verified, not live-infra-verified.
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
  type RevenueLedger,
  type SettlementEntry,
  InMemoryRevenueLedger,
  DEFAULT_RESULT_TTL_SECONDS,
} from "@utter/x402-arc";
import type { FacilitatorStores } from "./memory";

const RES_PREFIX = "resv:"; // reservation lock key prefix
const RES_BUYER_SET_PREFIX = "resvbuyerset:"; // per-buyer SET of live reservation idemKeys
const RES_BUYER_CAP_PREFIX = "resvbuyercap:"; // per-(buyer,idemKey) cap value
const SPENT_PREFIX = "spent:"; // spent-nonce membership key prefix
const STRIKE_PREFIX = "strike:"; // per-resource strike counter key prefix
const SETTLE_TX_PREFIX = "settletx:"; // nonce -> settle tx hash (WR-02 receipt rebuild)

/** Postgres-backed PaymentStore with Redis reservation locks + spent-nonce cache. */
export class PgRedisPaymentStore implements PaymentStore {
  private readonly pg: Pool;
  private readonly redis: Redis;

  constructor(pg: Pool, redis: Redis) {
    this.pg = pg;
    this.redis = redis;
  }

  async reserve(lock: ReservationLock): Promise<boolean> {
    // Spent nonces can never be re-reserved (the on-chain usedNonce is the final
    // authority; this is the off-chain short-circuit).
    if ((await this.redis.exists(`${SPENT_PREFIX}${lock.idemKey}`)) === 1) {
      return false;
    }
    const ttlMs = Math.max(1, lock.expiresAt - Date.now());
    const buyerKey = lock.buyer.toLowerCase();
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
    // Track the live reservation under the buyer for outstandingReserved via a
    // per-buyer SET of idemKeys (SADD/SREM/SMEMBERS - NO O(N) `keys` scan, WR-05).
    // The per-(buyer,idemKey) cap value carries the same TTL so it self-expires; the
    // SET member is pruned lazily in outstandingReserved when its cap key is gone.
    await this.redis.sadd(`${RES_BUYER_SET_PREFIX}${buyerKey}`, lock.idemKey);
    await this.redis.set(
      `${RES_BUYER_CAP_PREFIX}${buyerKey}:${lock.idemKey}`,
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

  /** Drop the reservation lock + the per-buyer SET member + cap value atomically. */
  private async dropReservation(idemKey: Hex, extra?: (multi: ReturnType<Redis["multi"]>) => void): Promise<void> {
    // Read the lock to learn the buyer (so we target the per-buyer SET precisely
    // without an O(N) keys scan). A missing lock is a no-op.
    const raw = await this.redis.get(`${RES_PREFIX}${idemKey}`);
    const buyer = raw ? (JSON.parse(raw) as { buyer: string }).buyer.toLowerCase() : null;
    const multi = this.redis.multi();
    multi.del(`${RES_PREFIX}${idemKey}`);
    if (buyer) {
      multi.srem(`${RES_BUYER_SET_PREFIX}${buyer}`, idemKey);
      multi.del(`${RES_BUYER_CAP_PREFIX}${buyer}:${idemKey}`);
    }
    if (extra) extra(multi);
    await multi.exec();
  }

  async release(idemKey: Hex): Promise<void> {
    await this.dropReservation(idemKey);
    await this.pg.query(`UPDATE payments SET status = 'released' WHERE idem_key = $1`, [idemKey]);
  }

  async markNonceSpent(idemKey: Hex): Promise<void> {
    // Atomic spent + lock-release in ONE MULTI so a crash cannot leave the spent
    // marker set without the reservation cleared (or vice versa) (WR-05). The
    // permanent spent marker (no TTL) means a settled nonce can never be re-reserved.
    await this.dropReservation(idemKey, (multi) => {
      multi.set(`${SPENT_PREFIX}${idemKey}`, "1");
    });
    await this.pg.query(`UPDATE payments SET status = 'settled' WHERE idem_key = $1`, [idemKey]);
  }

  async isNoncePending(idemKey: Hex): Promise<boolean> {
    return (await this.redis.exists(`${RES_PREFIX}${idemKey}`)) === 1;
  }

  async outstandingReserved(buyer: Hex): Promise<bigint> {
    // Sum the live (unexpired) reservation caps for this buyer via the per-buyer SET
    // (SMEMBERS), NOT a global `keys` scan (WR-05). An idemKey whose cap key has
    // TTL-expired is pruned from the SET lazily here so a stale member never inflates
    // the outstanding sum.
    const buyerKey = buyer.toLowerCase();
    const idemKeys = await this.redis.smembers(`${RES_BUYER_SET_PREFIX}${buyerKey}`);
    if (idemKeys.length === 0) return 0n;
    const capKeys = idemKeys.map((k) => `${RES_BUYER_CAP_PREFIX}${buyerKey}:${k}`);
    const values = await this.redis.mget(...capKeys);
    let sum = 0n;
    const expired: string[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v) sum += BigInt(v);
      else expired.push(idemKeys[i] as string);
    }
    if (expired.length > 0) {
      await this.redis.srem(`${RES_BUYER_SET_PREFIX}${buyerKey}`, ...expired);
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

  async recordSettleTx(idemKey: Hex, txHash: Hex): Promise<void> {
    // SET NX: the FIRST broadcast's tx hash wins; a retry never overwrites it (the
    // nonce->txHash mapping the WR-02 receipt rebuild reads). Permanent (no TTL) -
    // a settled nonce's tx hash must outlive the reservation for crash recovery.
    await this.redis.set(`${SETTLE_TX_PREFIX}${idemKey}`, txHash, "NX");
  }

  async getSettleTx(idemKey: Hex): Promise<Hex | null> {
    const v = await this.redis.get(`${SETTLE_TX_PREFIX}${idemKey}`);
    return v ? (v as Hex) : null;
  }
}

/** Postgres-backed ResultStore (durable persisted settle results; TTL-pruned). */
export class PgRedisResultStore implements ResultStore {
  private readonly pg: Pool;

  constructor(pg: Pool) {
    this.pg = pg;
  }

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

/**
 * Postgres-backed RevenueLedger (durable per-resource settlement log). Mirrors the
 * InMemoryRevenueLedger contract so a facilitator restart no longer zeroes a
 * creator's revenue history (the studio dashboard reads this via GET /revenue):
 *   - record is IDEMPOTENT on idemKey (INSERT ... ON CONFLICT (idem_key) DO NOTHING),
 *     so a settle retry that re-enters the record path never double-counts revenue
 *     (the exactly-once money guard's sibling).
 *   - byResource returns the entries for one resource in RECORD ORDER (ORDER BY seq).
 *
 * Shares the same pg Pool as the payment/result stores (no second Pool). Parameterized
 * queries only; never string-concatenated SQL. Every USDC amount is stored as TEXT and
 * parsed back to bigint at the boundary - never a JS number (no precision loss), never
 * a decimals literal. The `revenue` table (idem_key PK, resource_id, kind, amount,
 * creator_share, platform_share, tx, seq bigserial, recorded_at) carries an auto seq
 * for stable record order.
 */
export class PgRevenueLedger implements RevenueLedger {
  private readonly pg: Pool;

  constructor(pg: Pool) {
    this.pg = pg;
  }

  async record(entry: SettlementEntry): Promise<void> {
    // Idempotent on idem_key: a settle retry re-enters here, but the revenue for that
    // nonce must be counted exactly once. ON CONFLICT DO NOTHING drops the duplicate.
    await this.pg.query(
      `INSERT INTO revenue
         (idem_key, resource_id, kind, amount, creator_share, platform_share, tx, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
       ON CONFLICT (idem_key) DO NOTHING`,
      [
        entry.idemKey,
        entry.resourceId,
        entry.kind,
        entry.amount.toString(),
        entry.creatorShare.toString(),
        entry.platformShare.toString(),
        entry.tx,
        entry.at,
      ],
    );
  }

  async byResource(resourceId: Hex): Promise<SettlementEntry[]> {
    const { rows } = await this.pg.query<{
      idem_key: Hex;
      resource_id: Hex;
      kind: string;
      amount: string;
      creator_share: string;
      platform_share: string;
      tx: Hex;
      recorded_at: string;
    }>(
      `SELECT idem_key, resource_id, kind, amount, creator_share, platform_share, tx, recorded_at
       FROM revenue WHERE resource_id = $1 ORDER BY seq`,
      [resourceId],
    );
    // Reconstruct each SettlementEntry: money strings -> bigint at the boundary.
    return rows.map((row) => ({
      idemKey: row.idem_key,
      resourceId: row.resource_id,
      amount: BigInt(row.amount),
      creatorShare: BigInt(row.creator_share),
      platformShare: BigInt(row.platform_share),
      tx: row.tx,
      kind: row.kind === "refund" ? "refund" : "settle",
      at: new Date(row.recorded_at).getTime(),
    }));
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
    // The revenue ledger SHARES the same pg Pool (no second Pool). It is durable, so a
    // facilitator restart no longer zeroes a creator's revenue history.
    revenueLedger: new PgRevenueLedger(pg),
  };
}
