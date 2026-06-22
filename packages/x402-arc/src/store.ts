// PaymentStore / ResultStore contract + in-memory adapters (PAY-09, PAY-11).
//
// This is the single shared persistence contract for the escrow money path. The
// in-memory adapters here are the TEST DEFAULT so the full reservation +
// exactly-once suite runs green on Windows with no Postgres/Redis (CONTEXT
// "Pluggable store interface"); the facilitator's pg+redis adapter (real runs)
// implements the SAME interfaces, so tests exercise the contract, not a stub.
//
// idemKey is the payment `nonce` (bytes32 Hex) per SPEC §9.11 - retries key on it,
// the buyer never re-signs. Reservation is off-chain (Pattern 4): the on-chain
// `debit` (which reverts on insufficient funds / replayed nonce) is the final
// authority, so a store bug can only cause a late revert, never an overspend.
import type { Hex } from "viem";

/**
 * An off-chain reservation lock written by `/verify` before the handler runs.
 * TTL is enforced via `expiresAt` (epoch ms): `maxTimeoutSeconds + settleBuffer`.
 */
export interface ReservationLock {
  /** The payment nonce (bytes32 Hex) - the idempotency key for the whole call. */
  idemKey: Hex;
  /** The buyer whose on-chain balance backs this reservation (lower-cased Address). */
  buyer: Hex;
  /** The signed spend cap in USDC base units. Never a decimals-scaled number. */
  cap: bigint;
  /** The resource being charged (bytes32 Hex). */
  resourceId: Hex;
  /** Epoch ms after which the reservation is considered expired/released. */
  expiresAt: number;
}

/**
 * The persisted result of a settled call, served by `GET /results/:idemKey`
 * within the TTL so a buyer that disconnected after the debit can retrieve it
 * without re-charging.
 */
export interface StoredResult {
  /** The payment nonce (bytes32 Hex). */
  idemKey: Hex;
  /** The exact response body bytes returned to the buyer (for replay). */
  response: string;
  /** The settle receipt (tx hash, payer, amount, idemKey). Shape is settle-defined. */
  receipt: unknown;
  /** Epoch ms the result was stored (TTL is measured from here). */
  storedAt: number;
}

/**
 * Reservation + nonce + strike state. The escrow money path's only mutable
 * off-chain store. All methods are async so the pg+redis adapter can implement
 * the identical contract.
 */
export interface PaymentStore {
  /**
   * Reserve the signed cap for a nonce. Returns false if the nonce is already
   * pending or has been marked spent (idempotency at the store layer), so a
   * concurrent or replayed verify cannot double-reserve.
   */
  reserve(lock: ReservationLock): Promise<boolean>;
  /** Release a reservation (declared-error / malfunction / timeout path). */
  release(idemKey: Hex): Promise<void>;
  /** Mark a nonce permanently spent after a successful settle. */
  markNonceSpent(idemKey: Hex): Promise<void>;
  /** True while a nonce holds a live (unexpired) reservation. */
  isNoncePending(idemKey: Hex): Promise<boolean>;
  /**
   * Sum of the caps of every live (unexpired) reservation for one buyer. This is
   * the off-chain "already committed" amount: `/verify` rejects a new reservation
   * when `onchain balanceOf(buyer) - outstandingReserved(buyer) < cap`, so two
   * sequential verifies with different nonces cannot over-commit one balance. The
   * on-chain `debit` revert remains the FINAL authority; this is defense in depth.
   */
  outstandingReserved(buyer: Hex): Promise<bigint>;
  /** Record a malfunction strike against a resource (Phase 5 acts on the count). */
  recordStrike(resourceId: Hex, reason: string): Promise<void>;
  /** Current strike count for a resource. */
  getStrikes(resourceId: Hex): Promise<number>;
  /**
   * Persist the on-chain settle tx hash for a nonce, written just before the debit
   * is broadcast. On a retry-after-crash (the on-chain nonce reports used) the
   * receipt is rebuilt by reading THIS single tx receipt rather than scanning the
   * entire contract event history (WR-02). Idempotent: a re-record is a no-op.
   */
  recordSettleTx(idemKey: Hex, txHash: Hex): Promise<void>;
  /** The persisted settle tx hash for a nonce, or null if none was recorded. */
  getSettleTx(idemKey: Hex): Promise<Hex | null>;
}

/** Persisted settle results, keyed on idemKey, expiring after a TTL. */
export interface ResultStore {
  /** Fetch a stored result, or null if absent or TTL-expired. */
  get(idemKey: Hex): Promise<StoredResult | null>;
  /** Persist a result. `ttlSeconds` defaults to 24h (CONTEXT result retention). */
  put(result: StoredResult, ttlSeconds?: number): Promise<void>;
}

/** Default result retention: 24 hours (CONTEXT "default 24h"). */
export const DEFAULT_RESULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * In-memory PaymentStore (test default). Map-backed; reservations expire by
 * `expiresAt` lazily on read so a stale lock never blocks a fresh reserve.
 * Spent nonces are tracked separately so a settled nonce can never be re-reserved.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly reservations = new Map<Hex, ReservationLock>();
  private readonly spentNonces = new Set<Hex>();
  private readonly strikes = new Map<Hex, number>();
  private readonly settleTx = new Map<Hex, Hex>();

  /** Drop a reservation if it exists and is past its TTL. Returns true if live. */
  private isLive(idemKey: Hex): boolean {
    const lock = this.reservations.get(idemKey);
    if (!lock) return false;
    if (lock.expiresAt <= Date.now()) {
      this.reservations.delete(idemKey);
      return false;
    }
    return true;
  }

  async reserve(lock: ReservationLock): Promise<boolean> {
    if (this.spentNonces.has(lock.idemKey)) return false;
    if (this.isLive(lock.idemKey)) return false;
    this.reservations.set(lock.idemKey, lock);
    return true;
  }

  async release(idemKey: Hex): Promise<void> {
    this.reservations.delete(idemKey);
  }

  async markNonceSpent(idemKey: Hex): Promise<void> {
    this.spentNonces.add(idemKey);
    this.reservations.delete(idemKey);
  }

  async isNoncePending(idemKey: Hex): Promise<boolean> {
    return this.isLive(idemKey);
  }

  async outstandingReserved(buyer: Hex): Promise<bigint> {
    const target = buyer.toLowerCase();
    let sum = 0n;
    // Iterate a snapshot of keys so the lazy-expiry delete inside isLive() does
    // not mutate the map mid-iteration.
    for (const idemKey of [...this.reservations.keys()]) {
      if (!this.isLive(idemKey)) continue;
      const lock = this.reservations.get(idemKey);
      if (lock && lock.buyer.toLowerCase() === target) sum += lock.cap;
    }
    return sum;
  }

  async recordStrike(resourceId: Hex, _reason: string): Promise<void> {
    this.strikes.set(resourceId, (this.strikes.get(resourceId) ?? 0) + 1);
  }

  async getStrikes(resourceId: Hex): Promise<number> {
    return this.strikes.get(resourceId) ?? 0;
  }

  async recordSettleTx(idemKey: Hex, txHash: Hex): Promise<void> {
    if (!this.settleTx.has(idemKey)) this.settleTx.set(idemKey, txHash);
  }

  async getSettleTx(idemKey: Hex): Promise<Hex | null> {
    return this.settleTx.get(idemKey) ?? null;
  }
}

/**
 * In-memory ResultStore (test default). Map-backed; entries expire by their TTL
 * lazily on read so an expired idemKey returns null (the `GET /results/:idemKey`
 * 404 path) without a sweeper.
 */
export class InMemoryResultStore implements ResultStore {
  private readonly results = new Map<Hex, { result: StoredResult; expiresAt: number }>();

  async get(idemKey: Hex): Promise<StoredResult | null> {
    const entry = this.results.get(idemKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.results.delete(idemKey);
      return null;
    }
    return entry.result;
  }

  async put(result: StoredResult, ttlSeconds: number = DEFAULT_RESULT_TTL_SECONDS): Promise<void> {
    this.results.set(result.idemKey, {
      result,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

/**
 * One settled (or refunded) call, recorded for per-resource revenue aggregation.
 *
 * This is a SEPARATE concern from PaymentStore/ResultStore: the ResultStore is keyed
 * by idemKey only and its reservation (which carries the resourceId) is DELETED on
 * settle, so there is no revenue-by-resource source there. The RevenueLedger keeps a
 * resourceId-keyed append log so the studio dashboard can show real gross / split /
 * refund totals from actual facilitator settlements.
 *
 * All money is USDC base units (bigint); the legs are the on-chain authoritative
 * values (the `toCreator`/`toTreasury` the PaymentEscrow.debit `Debited` event emits),
 * never a re-derived bps split. `amount === creatorShare + platformShare` for a settle.
 */
export interface SettlementEntry {
  /** The payment nonce (bytes32 Hex) - also the idempotency key for the record. */
  idemKey: Hex;
  /** The resource the settlement was charged against (bytes32 Hex). */
  resourceId: Hex;
  /** The debited amount in USDC base units (the receipt amount). */
  amount: bigint;
  /** The creator leg in base units (the on-chain `toCreator`, not recomputed here). */
  creatorShare: bigint;
  /** The platform/treasury leg in base units (the on-chain `toTreasury`). */
  platformShare: bigint;
  /** The on-chain settlement tx hash (bytes32 Hex). */
  tx: Hex;
  /** Whether this entry is a debit (settle) or a refund. */
  kind: "settle" | "refund";
  /** Epoch ms the entry was recorded. */
  at: number;
}

/**
 * A per-resource revenue ledger. Records each settlement/refund and serves the rows
 * back for one resource. Async so a later durable (pg/redis) adapter implements the
 * SAME contract; the in-memory adapter is the default.
 */
export interface RevenueLedger {
  /** Record one settlement/refund. Idempotent on idemKey (a re-record is a no-op). */
  record(entry: SettlementEntry): Promise<void>;
  /** Every recorded entry for a resource, in record order (a defensive copy). */
  byResource(resourceId: Hex): Promise<SettlementEntry[]>;
}

/**
 * In-memory RevenueLedger (the default; not part of PaymentStore/ResultStore and NOT
 * pg/redis-backed). A `Map<resourceId, SettlementEntry[]>` plus an idemKey set so a
 * settle RETRY (which re-enters this record path) never double-counts a resource's
 * revenue: re-recording the same idemKey is a no-op.
 *
 * NOTE: a durable pg/redis-backed RevenueLedger (so revenue survives a facilitator
 * restart) is a deliberate LATER increment - this in-memory ledger is intentionally
 * process-local, mirroring the in-memory PaymentStore/ResultStore test default.
 */
export class InMemoryRevenueLedger implements RevenueLedger {
  private readonly byResourceId = new Map<Hex, SettlementEntry[]>();
  private readonly recorded = new Set<Hex>();

  async record(entry: SettlementEntry): Promise<void> {
    // Idempotent on idemKey: a settle retry re-enters here, but the revenue for that
    // nonce must be counted exactly once (mirrors the exactly-once money guard).
    if (this.recorded.has(entry.idemKey)) return;
    this.recorded.add(entry.idemKey);
    const rows = this.byResourceId.get(entry.resourceId);
    // Store a copy so a later caller mutation cannot poison the ledger.
    const row: SettlementEntry = { ...entry };
    if (rows) {
      rows.push(row);
    } else {
      this.byResourceId.set(entry.resourceId, [row]);
    }
  }

  async byResource(resourceId: Hex): Promise<SettlementEntry[]> {
    const rows = this.byResourceId.get(resourceId);
    // Defensive copy (rows + each entry) so the caller cannot mutate the ledger.
    return rows ? rows.map((r) => ({ ...r })) : [];
  }
}
