// card-store.ts - the FINALIZED A2A card serving cache (MKT-01/02).
//
// The CardStore holds the FINALIZED, validateAgentCard-valid card the marketplace
// SERVES, authored by the publish pipeline's mint+probe+bond finalize step (publish.ts
// step 5). It is a read-through serving cache, NOT a second source of identity or money
// truth: pricing and identity still resolve canonically (the card x402 block + the
// on-chain reads), and the card route re-validates with validateAgentCard before
// serving, so a poisoned card 500s rather than being served as valid (T-05-06-CARDPATH).
//
// The InMemoryCardStore is the autonomous test default, mirroring the InMemoryIndexStore
// idiom. The Postgres adapter (real runs) implements this SAME CardStore interface, so
// callers swap by env without change (that adapter is a later subtask).
import type { Hex } from "./index-store.js";

/**
 * The finalized-card store contract. The Postgres adapter implements the SAME interface
 * so callers swap by env. The surface is intentionally minimal: put/get only - it holds
 * the finalized card the route serves and authors no money/identity value of its own.
 */
export interface CardStore {
  /** Persist the finalized, validateAgentCard-valid card for a resource. */
  put(resourceId: Hex, card: Record<string, unknown>): Promise<void>;
  /** Read the finalized card for a resource, or null if unknown. */
  get(resourceId: Hex): Promise<Record<string, unknown> | null>;
}

/**
 * The in-memory CardStore (autonomous test default). Holds finalized cards in a Map
 * keyed by resourceId. A deep copy is taken on BOTH put and get (structuredClone), so a
 * caller that mutates the input after a put, or mutates a returned card, cannot poison
 * the stored card. The real Postgres adapter exposes the same interface.
 */
export class InMemoryCardStore implements CardStore {
  private readonly cards = new Map<Hex, Record<string, unknown>>();

  async put(resourceId: Hex, card: Record<string, unknown>): Promise<void> {
    // Deep-copy on store so a later caller mutation of the input cannot poison the card.
    this.cards.set(resourceId, structuredClone(card));
  }

  async get(resourceId: Hex): Promise<Record<string, unknown> | null> {
    const found = this.cards.get(resourceId);
    // Deep-copy on read so a caller mutation of the returned card cannot poison the store.
    return found ? structuredClone(found) : null;
  }
}
