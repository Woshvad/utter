// Payer sanctions screening (Compliance track, subtask 1). This is a payer-ADDRESS
// DENYLIST screen, NOT KYC: testnet has no KYC. The facilitator screens the claimed
// buyer address against a denylist of sanctioned addresses BEFORE the spend-cap gate
// and BEFORE the reserve, so a screened payer makes NO reservation and consumes ZERO
// compute (the same free-compute ordering the spend-cap gate already holds).
//
// Order on POST /verify: payer-screen -> spend-cap -> reserve -> handler.
//
// The interface is deliberately the seam a later subtask reuses: a real sanctions feed
// (a Postgres-backed or remote denylist adapter) implements this SAME PayerScreen
// interface, so the /verify wiring never changes when the in-memory list is swapped for
// a live feed. The gate is DENY-BY-DEFAULT on a screen throw: if isAllowed rejects (a
// feed read failure), the caller treats it as a denial and makes no reservation, so a
// screening outage never opens an unscreened money path (fail-closed).
//
// Never log payer addresses or the denylist contents.

/**
 * A payer (buyer) address screen. `isAllowed(payer)` resolves true when the payer is
 * NOT on the sanctions denylist (the call may proceed) and false when it IS denied.
 * It MAY throw (a feed read failure); the /verify gate treats a throw as a DENY
 * (fail-closed), never as an allow.
 */
export interface PayerScreen {
  isAllowed(payer: string): Promise<boolean>;
}

/**
 * The in-memory denylist screen: a Set of LOWERCASED denied addresses. `isAllowed`
 * returns true unless the lowercased payer is in the set. An empty set allows every
 * payer (the unarmed-but-present case). This is the dev/config-backed implementation;
 * a live sanctions feed implements the SAME PayerScreen interface in a later subtask.
 */
export class InMemoryPayerScreen implements PayerScreen {
  private readonly denied: Set<string>;

  constructor(denied: Set<string>) {
    this.denied = denied;
  }

  async isAllowed(payer: string): Promise<boolean> {
    return !this.denied.has(payer.toLowerCase());
  }
}

/**
 * Build an InMemoryPayerScreen from a raw address list. Each entry is trimmed and
 * lowercased; empty entries are dropped. A list of only empty/blank entries yields a
 * screen that allows everyone (an empty denylist). The caller (server.ts) never logs
 * the list.
 */
export function createPayerScreenFromList(addresses: string[]): InMemoryPayerScreen {
  const denied = new Set<string>();
  for (const raw of addresses) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 0) denied.add(normalized);
  }
  return new InMemoryPayerScreen(denied);
}
