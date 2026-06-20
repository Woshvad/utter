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
  type PaymentStore,
  type ResultStore,
} from "@utter/x402-arc";

/** The pair of stores the facilitator routes (`/verify`, `/release`, `/settle`). */
export interface FacilitatorStores {
  payments: PaymentStore;
  results: ResultStore;
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
  };
}

export { InMemoryPaymentStore, InMemoryResultStore };
