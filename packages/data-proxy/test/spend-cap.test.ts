// Spend-cap gate tests (SCL-05). A per-payer rolling-24h USDC spend cap, enforced
// BEFORE any compute (the facilitator mounts spendCapGate ahead of /verify reserve +
// handler in Plan 08-06 Task 2 - here we prove the store + gate logic core).
//
// CRITICAL divergences from the sibling quota gate (quota.ts):
//   - amounts are USDC base-unit `bigint` MONEY, never the plain call/byte counters,
//   - the window is rolling-24h over an INJECTED clock (no Date.now() in the math),
//   - the gate is deny-by-default: rolling + amount > cap -> "deny".
//
// The two accounting surfaces (money vs counts) are DISTINCT stores and are never
// summed - asserted here and grep-enforced in the plan verification.
import { describe, it, expect } from "vitest";
import {
  InMemorySpendCapStore,
  spendCapGate,
  type SpendCapStore,
} from "../src/index";

const PAYER_A = "0xpayer-aaaa";
const PAYER_B = "0xpayer-bbbb";
const HOUR = 3600; // injected clock is in seconds
const DAY = 24 * HOUR;

describe("InMemorySpendCapStore rolling-24h window (injected clock)", () => {
  it("recordSpend atomically adds and returns the new rolling-24h total (bigint base units)", async () => {
    const store = new InMemorySpendCapStore();
    expect(await store.recordSpend(PAYER_A, 100n, 0)).toBe(100n);
    expect(await store.recordSpend(PAYER_A, 250n, HOUR)).toBe(350n);
    // A zero-amount record is the pure read of the current window total.
    expect(await store.recordSpend(PAYER_A, 0n, 2 * HOUR)).toBe(350n);
  });

  it("keeps per-payer windows independent (no cross-payer sum)", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER_A, 500n, 0);
    await store.recordSpend(PAYER_B, 70n, 0);
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(500n);
    expect(await store.recordSpend(PAYER_B, 0n, HOUR)).toBe(70n);
  });

  it("drops spends older than 24h from the window deterministically via the injected clock", async () => {
    const store = new InMemorySpendCapStore();
    // Two spends at t=0 and t=1h.
    await store.recordSpend(PAYER_A, 100n, 0);
    await store.recordSpend(PAYER_A, 100n, HOUR);
    // At t just under 24h after the first, both are still in-window.
    expect(await store.recordSpend(PAYER_A, 0n, DAY - 1)).toBe(200n);
    // Advance the injected clock 24h+1s past the FIRST spend: it drops out, the second remains.
    expect(await store.recordSpend(PAYER_A, 0n, DAY + 1)).toBe(100n);
    // Advance 24h+1s past the SECOND spend too: the window empties.
    expect(await store.recordSpend(PAYER_A, 0n, DAY + HOUR + 1)).toBe(0n);
  });

  it("uses the injected now, not Date.now(): a recorded spend far in the simulated future is in-window", async () => {
    const store = new InMemorySpendCapStore();
    const future = 10 * 365 * DAY; // a decade ahead of any real wall clock
    await store.recordSpend(PAYER_A, 42n, future);
    expect(await store.recordSpend(PAYER_A, 0n, future + HOUR)).toBe(42n);
  });
});

describe("spendCapGate deny-by-default (rolling + amount > cap)", () => {
  it("allows when rolling + amount <= cap", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER_A, 600n, 0);
    expect(await spendCapGate(PAYER_A, 400n, 1000n, store, HOUR)).toBe("allow");
  });

  it("denies when rolling + amount > cap (the boundary is strict)", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER_A, 600n, 0);
    // 600 + 401 = 1001 > 1000 -> deny.
    expect(await spendCapGate(PAYER_A, 401n, 1000n, store, HOUR)).toBe("deny");
    // Exactly at the cap (600 + 400 == 1000) is allowed.
    expect(await spendCapGate(PAYER_A, 400n, 1000n, store, HOUR)).toBe("allow");
  });

  it("does NOT record the spend itself (the gate is a pure read; recording is the caller's job)", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER_A, 100n, 0);
    await spendCapGate(PAYER_A, 50n, 1000n, store, HOUR);
    // The window total is unchanged by the gate read.
    expect(await store.recordSpend(PAYER_A, 0n, HOUR)).toBe(100n);
  });

  it("re-allows once stale spends roll out of the 24h window (injected clock)", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER_A, 900n, 0);
    // Within the window, a 200 spend would exceed a 1000 cap.
    expect(await spendCapGate(PAYER_A, 200n, 1000n, store, HOUR)).toBe("deny");
    // After 24h+1s the old 900 drops out; the same 200 now fits.
    expect(await spendCapGate(PAYER_A, 200n, 1000n, store, DAY + 1)).toBe("allow");
  });

  it("treats amounts as bigint money (large base-unit values, no number coercion)", async () => {
    const store = new InMemorySpendCapStore();
    const cap = 5_000_000n; // 5 USDC at 6dp
    await store.recordSpend(PAYER_A, 4_999_999n, 0);
    expect(await spendCapGate(PAYER_A, 1n, cap, store, HOUR)).toBe("allow"); // == cap
    expect(await spendCapGate(PAYER_A, 2n, cap, store, HOUR)).toBe("deny"); // > cap
  });

  it("satisfies the SpendCapStore contract shape (a custom store works through the gate)", async () => {
    // A minimal hand-rolled store proving the gate depends only on the interface, not
    // the in-memory implementation - the Redis adapter drops in behind the same contract.
    let total = 700n;
    const custom: SpendCapStore = {
      async recordSpend(_payer, amount, _now) {
        total += amount;
        return total;
      },
    };
    expect(await spendCapGate(PAYER_A, 100n, 1000n, custom, 0)).toBe("allow");
    // The gate read (amount 0) must not mutate the total.
    expect(total).toBe(700n);
  });
});
