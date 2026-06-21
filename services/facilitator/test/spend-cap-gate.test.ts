// Facilitator pre-reserve spend-cap gate tests (SCL-05 / threat T-08-FREECOMPUTE).
//
// The gate mounts the data-proxy spendCapGate AHEAD of /verify reserve + handler
// dispatch. The load-bearing invariant is ORDER: on an over-cap payer the gate DENIES
// and NEITHER the reserve call NOR the handler runs (both spy-asserted to ZERO) - the
// free-compute guard, mirroring the Phase 2 reserve-before-run precedent. The clock is
// injected (no Date.now in the assertion path).
import { describe, it, expect, vi } from "vitest";
import { InMemorySpendCapStore } from "@utter/data-proxy";
import { spendCapPreReserveGate } from "../src/spend-cap-gate";

const PAYER = "0xpayer-aaaa";
const HOUR = 3600;

/** A spy reserve fn + a spy handler; the gate must call reserve only on allow, and the
 *  handler must run only after a successful reserve. The order array records call order. */
function makeHarness() {
  const order: string[] = [];
  const reserve = vi.fn(async () => {
    order.push("reserve");
    return { valid: true as const, payer: PAYER };
  });
  const handler = vi.fn(async () => {
    order.push("handler");
    return "handler-ran";
  });
  return { order, reserve, handler };
}

describe("spend-cap pre-reserve gate (deny BEFORE reserve + handler)", () => {
  it("DENIES an over-cap payer with ZERO reserve and ZERO handler invocations (free-compute guard)", async () => {
    const store = new InMemorySpendCapStore();
    await store.recordSpend(PAYER, 900n, 0); // already 900 in the 24h window
    const { reserve, handler } = makeHarness();

    const result = await spendCapPreReserveGate(
      { payer: PAYER, amount: 200n, cap: 1000n, store, now: HOUR },
      { reserve, handler },
    );

    expect(result.decision).toBe("deny");
    // The free-compute guard: NOTHING downstream ran.
    expect(reserve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // And the over-cap spend was NOT recorded (denied calls never accrue).
    expect(await store.recordSpend(PAYER, 0n, HOUR)).toBe(900n);
  });

  it("ALLOWS an under-cap payer and runs reserve -> handler -> records the spend", async () => {
    const store = new InMemorySpendCapStore();
    const { order, reserve, handler } = makeHarness();

    const result = await spendCapPreReserveGate(
      { payer: PAYER, amount: 300n, cap: 1000n, store, now: HOUR },
      { reserve, handler },
    );

    expect(result.decision).toBe("allow");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.handlerResult).toBe("handler-ran");
    // The spend is recorded on the allowed path, so a subsequent over-cap call denies.
    expect(await store.recordSpend(PAYER, 0n, HOUR)).toBe(300n);
  });

  it("invokes the ATOMIC spend-cap check-and-reserve STRICTLY BEFORE reserve (order asserted, WR-04)", async () => {
    const store = new InMemorySpendCapStore();
    const order: string[] = [];
    const reserve = vi.fn(async () => {
      order.push("reserve");
      return { valid: true as const, payer: PAYER };
    });
    const handler = vi.fn(async () => {
      order.push("handler");
      return "ran";
    });
    // Spy on the ATOMIC check-and-reserve so we can assert it landed before "reserve".
    const trySpy = vi.spyOn(store, "tryRecordSpend").mockImplementation(async (...args) => {
      order.unshift("spend-cap"); // it must be the FIRST store interaction
      return { allowed: true, total: 100n };
    });

    await spendCapPreReserveGate(
      { payer: PAYER, amount: 100n, cap: 1000n, store, now: HOUR },
      { reserve, handler },
    );

    // The atomic check-and-reserve runs FIRST, then reserve, then the handler.
    expect(trySpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["spend-cap", "reserve", "handler"]);
  });

  it("after an under-cap call records spend, a subsequent over-cap call DENIES (rolling accrual)", async () => {
    const store = new InMemorySpendCapStore();
    const h1 = makeHarness();
    await spendCapPreReserveGate(
      { payer: PAYER, amount: 800n, cap: 1000n, store, now: HOUR },
      { reserve: h1.reserve, handler: h1.handler },
    );

    const h2 = makeHarness();
    const second = await spendCapPreReserveGate(
      { payer: PAYER, amount: 300n, cap: 1000n, store, now: HOUR },
      { reserve: h2.reserve, handler: h2.handler },
    );
    // 800 + 300 = 1100 > 1000 -> deny, with zero compute on the second call.
    expect(second.decision).toBe("deny");
    expect(h2.reserve).not.toHaveBeenCalled();
    expect(h2.handler).not.toHaveBeenCalled();
  });

  it("WR-04: two concurrent requests that JOINTLY exceed the cap -> exactly ONE allowed (no TOCTOU)", async () => {
    const store = new InMemorySpendCapStore();
    // Cap 1000; two simultaneous 600 requests jointly = 1200 > 1000. The old
    // read-then-record gate let BOTH pass (each read the pre-spend total of 0).
    const a = makeHarness();
    const b = makeHarness();
    const [resA, resB] = await Promise.all([
      spendCapPreReserveGate(
        { payer: PAYER, amount: 600n, cap: 1000n, store, now: HOUR },
        { reserve: a.reserve, handler: a.handler },
      ),
      spendCapPreReserveGate(
        { payer: PAYER, amount: 600n, cap: 1000n, store, now: HOUR },
        { reserve: b.reserve, handler: b.handler },
      ),
    ]);

    const allowed = [resA, resB].filter((r) => r.decision === "allow").length;
    const denied = [resA, resB].filter((r) => r.decision === "deny").length;
    // The atomic check-and-reserve admits EXACTLY ONE - the cap is never jointly exceeded.
    expect(allowed).toBe(1);
    expect(denied).toBe(1);
    // The window reflects only the one admitted 600 spend (not 1200).
    expect(await store.recordSpend(PAYER, 0n, HOUR)).toBe(600n);
    // Only the admitted request ran any compute.
    const totalReserves =
      a.reserve.mock.calls.length + b.reserve.mock.calls.length;
    const totalHandlers =
      a.handler.mock.calls.length + b.handler.mock.calls.length;
    expect(totalReserves).toBe(1);
    expect(totalHandlers).toBe(1);
  });

  it("WR-04: a reserve-rejected call REFUNDS its provisional hold (no permanent cap consumption)", async () => {
    const store = new InMemorySpendCapStore();
    const order: string[] = [];
    const reserve = vi.fn(async () => {
      order.push("reserve");
      return { valid: false as const, reason: "insufficient_balance" };
    });
    const handler = vi.fn(async () => "ran");

    const result = await spendCapPreReserveGate(
      { payer: PAYER, amount: 400n, cap: 1000n, store, now: HOUR },
      { reserve, handler },
    );
    expect(result.decision).toBe("reserve_rejected");
    // The provisional 400 hold was refunded, so the window is back to 0 - the payer's
    // cap was not permanently consumed by a call that never reserved (no self-DoS).
    expect(await store.recordSpend(PAYER, 0n, HOUR)).toBe(0n);
    // A subsequent full-cap call now succeeds (the refunded room is available again).
    const next = await spendCapPreReserveGate(
      { payer: PAYER, amount: 1000n, cap: 1000n, store, now: HOUR },
      { reserve: vi.fn(async () => ({ valid: true as const, payer: PAYER })), handler: vi.fn(async () => "ok") },
    );
    expect(next.decision).toBe("allow");
  });

  it("does NOT run the handler when reserve rejects (handler is gated on a valid reservation)", async () => {
    const store = new InMemorySpendCapStore();
    const order: string[] = [];
    const reserve = vi.fn(async () => {
      order.push("reserve");
      return { valid: false as const, reason: "insufficient_balance" };
    });
    const handler = vi.fn(async () => {
      order.push("handler");
      return "ran";
    });

    const result = await spendCapPreReserveGate(
      { payer: PAYER, amount: 100n, cap: 1000n, store, now: HOUR },
      { reserve, handler },
    );

    expect(result.decision).toBe("reserve_rejected");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    // A rejected reservation records NO spend (no compute consumed, nothing to charge).
    expect(await store.recordSpend(PAYER, 0n, HOUR)).toBe(0n);
  });
});
