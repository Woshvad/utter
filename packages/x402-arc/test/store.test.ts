// In-memory PaymentStore / ResultStore round-trip suite (PAY-09, PAY-11).
// Pure offline unit tests - no env, no RPC, no external services - so they run on
// the in-memory test default per CONTEXT. Asserts the shared store contract:
// reserve -> isNoncePending -> release, double-reserve idempotency, spent-nonce
// blocks re-reserve, strike counting, and ResultStore put/get + TTL expiry.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Hex } from "viem";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  type ReservationLock,
  type StoredResult,
} from "../src/store";

const NONCE: Hex = `0x${"11".repeat(32)}`;
const RESOURCE: Hex = `0x${"22".repeat(32)}`;

function lock(overrides: Partial<ReservationLock> = {}): ReservationLock {
  return {
    idemKey: NONCE,
    cap: 10_000n,
    resourceId: RESOURCE,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryPaymentStore", () => {
  it("round-trips reserve -> isNoncePending -> release", async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.reserve(lock())).toBe(true);
    expect(await store.isNoncePending(NONCE)).toBe(true);
    await store.release(NONCE);
    expect(await store.isNoncePending(NONCE)).toBe(false);
  });

  it("double-reserve returns false (store-layer idempotency)", async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.reserve(lock())).toBe(true);
    expect(
      await store.reserve(lock()),
      "a second reserve of a pending nonce must fail (no double-reserve)",
    ).toBe(false);
  });

  it("re-reserve succeeds once the reservation is released", async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.reserve(lock())).toBe(true);
    await store.release(NONCE);
    expect(await store.reserve(lock())).toBe(true);
  });

  it("markNonceSpent permanently blocks re-reserve", async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.reserve(lock())).toBe(true);
    await store.markNonceSpent(NONCE);
    expect(await store.isNoncePending(NONCE)).toBe(false);
    expect(
      await store.reserve(lock()),
      "a spent nonce must never be re-reservable (replay guard)",
    ).toBe(false);
  });

  it("expires a stale reservation on read so a fresh reserve succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00Z"));
    const store = new InMemoryPaymentStore();
    expect(await store.reserve(lock({ expiresAt: Date.now() + 1_000 }))).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(await store.isNoncePending(NONCE)).toBe(false);
    expect(await store.reserve(lock({ expiresAt: Date.now() + 1_000 }))).toBe(true);
  });

  it("recordStrike increments getStrikes per resource", async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.getStrikes(RESOURCE)).toBe(0);
    await store.recordStrike(RESOURCE, "invalid_output");
    await store.recordStrike(RESOURCE, "timeout");
    expect(await store.getStrikes(RESOURCE)).toBe(2);
  });
});

describe("InMemoryResultStore", () => {
  const result: StoredResult = {
    idemKey: NONCE,
    response: JSON.stringify({ echo: "hi", length: 2 }),
    receipt: { tx: `0x${"ab".repeat(32)}`, amount: "10000" },
    storedAt: Date.now(),
  };

  it("put/get returns the stored result", async () => {
    const store = new InMemoryResultStore();
    expect(await store.get(NONCE)).toBeNull();
    await store.put(result, 3600);
    expect(await store.get(NONCE)).toEqual(result);
  });

  it("get returns null after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00Z"));
    const store = new InMemoryResultStore();
    await store.put({ ...result, storedAt: Date.now() }, 1);
    expect(await store.get(NONCE)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(
      await store.get(NONCE),
      "an expired idemKey must 404 (return null) past its TTL",
    ).toBeNull();
  });
});
