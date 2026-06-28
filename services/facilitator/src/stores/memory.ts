// Facilitator in-memory store (test default; PAY-09, PAY-11).
//
// The reservation + exactly-once logic is identical across adapters, so the
// facilitator re-uses the canonical in-memory adapters from @utter/x402-arc
// rather than maintaining a divergent stub. The pg+redis adapter (real runs,
// Wave 2) implements the SAME PaymentStore / ResultStore interfaces, so tests
// exercise the shared contract, not a fork. This module is the facilitator-side
// factory that wires the two stores together at server bootstrap.
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  InMemoryRevenueLedger,
  type PaymentStore,
  type ResultStore,
  type RevenueLedger,
} from "@utter/x402-arc";

/** The stores the facilitator routes (`/verify`, `/release`, `/settle`, `/revenue`). */
export interface FacilitatorStores {
  payments: PaymentStore;
  results: ResultStore;
  /** Per-resource revenue ledger the studio dashboard reads via GET /revenue. */
  revenueLedger: RevenueLedger;
  /**
   * Teardown for the durable adapter (pg.end + redis.quit), called from graceful
   * shutdown AFTER the request drain. Undefined for the in-memory default (nothing to
   * close), so dev/test boot is byte-unchanged.
   */
  close?: () => Promise<void>;
}

/**
 * Build the in-memory facilitator stores (test default - no Postgres/Redis). The
 * real pg+redis adapter (Wave 2) exposes the same `FacilitatorStores` shape so
 * `server.ts` can swap adapters by env without touching the route logic.
 */
export function createInMemoryStores(): FacilitatorStores {
  return {
    payments: new InMemoryPaymentStore(),
    results: new InMemoryResultStore(),
    revenueLedger: new InMemoryRevenueLedger(),
  };
}

export { InMemoryPaymentStore, InMemoryResultStore };
