// query.ts - the pure discovery filter over the projected index records (MKT-02).
//
// filterResources is a PURE filter (no I/O), mirroring the reconcile() pure-diff
// idiom. It supports the discovery criteria an agent operator queries before paying
// per call: category, price range, min reputation, min uptime, min bond, and active.
// All amounts are token base units compared as bigint - never a 1e6 decimals literal.
import type { IndexRecord } from "./index-store.js";

/** The discovery filter criteria. Every field is optional (an absent field matches all). */
export interface FilterCriteria {
  /** Exact-match category. */
  category?: string;
  /** Only active (listed) resources when true; only delisted when false. */
  active?: boolean;
  /** Minimum projected reputation (feedbackCount), inclusive. */
  minReputation?: bigint;
  /** Minimum projected 0..1 uptime/health, inclusive. */
  minUptime?: number;
  /** Minimum posted bond in base units, inclusive. */
  minBond?: bigint;
  /** Maximum per-call base price in base units, inclusive. */
  maxBasePrice?: bigint;
  /** Minimum per-call base price in base units, inclusive. */
  minBasePrice?: bigint;
}

/**
 * Filter the projected records by the criteria (logical AND). Pure: it returns a
 * new array and never mutates the input. Price is read from the projected
 * pricing.base (base units, parsed as bigint) - the index is a read-through
 * projection, so this only surfaces values resolved from the card/on-chain sources.
 */
export function filterResources(
  records: readonly IndexRecord[],
  criteria: FilterCriteria,
): IndexRecord[] {
  return records.filter((r) => {
    if (criteria.category !== undefined && r.category !== criteria.category) return false;
    if (criteria.active !== undefined && r.active !== criteria.active) return false;
    if (criteria.minReputation !== undefined && r.reputation < criteria.minReputation) return false;
    if (criteria.minUptime !== undefined && r.uptime < criteria.minUptime) return false;
    if (criteria.minBond !== undefined && r.bond < criteria.minBond) return false;
    if (criteria.maxBasePrice !== undefined || criteria.minBasePrice !== undefined) {
      const base = BigInt(r.pricing.base);
      if (criteria.maxBasePrice !== undefined && base > criteria.maxBasePrice) return false;
      if (criteria.minBasePrice !== undefined && base < criteria.minBasePrice) return false;
    }
    return true;
  });
}
