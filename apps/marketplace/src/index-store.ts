// index-store.ts - the marketplace index as a READ-THROUGH PROJECTION (MKT-02).
//
// The IndexStore is the discovery cache an agent operator queries before paying
// per call. It is NEVER a second source of truth for money or identity: every
// price/reputation/bond value it holds is PROJECTED from its real source - pricing
// from the card x402 block, reputation from the Scorer + ERC-8004 readReputation,
// bond from StakingVault.bonds(). The store exposes only upsert/get/list/delist; it
// has NO setter that authors a money/identity value independently of upsert (which
// mirrors the source). A poisoned index entry therefore cannot enable payment or
// identity spoofing, because the card route + on-chain reads resolve the canonical
// values (T-05-06-INDEXTRUST).
//
// The InMemoryIndexStore is the autonomous test default, mirroring the facilitator
// store adapter idiom (services/facilitator/src/stores/memory.ts). The Postgres-
// shaped adapter (real runs) implements the SAME IndexStore interface - the columns
// map to the SPEC §10 resources/bonds tables - so query/route logic swaps adapters
// by env without change.

/**
 * A 0x-prefixed hex string (the on-chain resourceId shape). Declared locally rather
 * than imported from viem so @utter/marketplace does not take a direct viem dep just
 * for a type alias; it is structurally identical to viem's Hex.
 */
export type Hex = `0x${string}`;

/** The pricing block projected from the card x402 (base units, never a 1e6 literal). */
export interface ProjectedPricing {
  model: string;
  /** Per-call base price in token base units (string to avoid precision loss). */
  base: string;
  /** Per-KB price in base units. */
  perKB: string;
  /** The escrow cap in base units. */
  max: string;
}

/** The health block projected from the Scorer (verified flag + 0..1 score). */
export interface ProjectedHealth {
  verified: boolean;
  score: number | null;
}

/**
 * One discovery record per resource - a READ-THROUGH PROJECTION. The store never
 * authors these values; it mirrors them from their canonical sources at upsert.
 */
export interface IndexRecord {
  /** The on-chain resourceId (bytes32). */
  resourceId: Hex;
  /** The ERC-8004 agentId (decimal string), projected from the mint. */
  agentId: string;
  /** The discovery slug. */
  slug: string;
  /** The listing category (data / compute / ...). */
  category: string;
  /** Pricing projected from the card x402 block. */
  pricing: ProjectedPricing;
  /** feedbackCount projected from ERC-8004 readReputation. */
  reputation: bigint;
  /** The rolling 0..1 health score projected from the Scorer. */
  uptime: number;
  /** The full health block projected from the Scorer. */
  health: ProjectedHealth;
  /** The posted bond in base units, projected from StakingVault.bonds(). */
  bond: bigint;
  /** The absolute URL of the resource's /.well-known/agent-card.json. */
  cardUrl: string;
  /** Whether the resource is currently listed for discovery. */
  active: boolean;
}

/**
 * The index store contract. The Postgres adapter (real runs) implements the SAME
 * interface so callers swap by env. The surface is intentionally minimal:
 * upsert/get/list/delist - and NO money/identity setter (read-through only).
 */
export interface IndexStore {
  /** Insert or replace the projected record for a resource. */
  upsert(record: IndexRecord): Promise<void>;
  /** Read the projected record for a resource, or null if unknown. */
  get(resourceId: Hex): Promise<IndexRecord | null>;
  /** List every projected record. */
  list(): Promise<IndexRecord[]>;
  /** Remove a resource from discovery (active=false). Idempotent; no-op if unknown. */
  delist(resourceId: Hex): Promise<void>;
}

/**
 * The in-memory IndexStore (autonomous test default). Holds projected records in a
 * Map keyed by resourceId. The real Postgres adapter exposes the same interface.
 */
export class InMemoryIndexStore implements IndexStore {
  private readonly records = new Map<Hex, IndexRecord>();

  async upsert(record: IndexRecord): Promise<void> {
    // Store a shallow copy so a later caller mutation cannot poison the index.
    this.records.set(record.resourceId, { ...record });
  }

  async get(resourceId: Hex): Promise<IndexRecord | null> {
    const found = this.records.get(resourceId);
    return found ? { ...found } : null;
  }

  async list(): Promise<IndexRecord[]> {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  async delist(resourceId: Hex): Promise<void> {
    const found = this.records.get(resourceId);
    // Idempotent no-op for an unknown resource (it is already not discoverable).
    if (!found) return;
    this.records.set(resourceId, { ...found, active: false });
  }
}
