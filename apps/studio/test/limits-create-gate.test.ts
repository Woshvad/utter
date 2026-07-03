// limits-create-gate.test.ts - the /create admission gate deny matrix (S3).
//
// Constructs CreateGate directly with an injected env + clock (never the module
// singleton), so every window limit is explicit and no real time passes.
import { describe, it, expect } from "vitest";
import { CreateGate } from "../app/limits/create-gate.server";

function makeClock(start = 5_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** High-limit defaults so each case can pin ONE window low. */
const OPEN: NodeJS.ProcessEnv = {
  CREATE_BURST_GLOBAL: "1000",
  CREATE_LIMIT_GLOBAL_PER_DAY: "1000",
  CREATE_LIMIT_PER_IP_PER_HOUR: "1000",
  CREATE_BURST_PER_CREATOR: "1000",
  CREATE_LIMIT_PER_CREATOR_PER_DAY: "1000",
};

const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("CreateGate deny matrix", () => {
  it("denies on creator_burst after the per-creator burst is spent", () => {
    const clock = makeClock();
    const gate = new CreateGate({ ...OPEN, CREATE_BURST_PER_CREATOR: "2" }, clock.now);
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    const denied = gate.check(A, "1.1.1.1");
    expect(denied).toMatchObject({ allowed: false, reason: "creator_burst" });
    if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(0);
    // A different creator from the same IP is unaffected (fairness window only).
    expect(gate.check(B, "1.1.1.1").allowed).toBe(true);
  });

  it("denies on ip_hourly for distinct creators sharing one source IP (wallets are free)", () => {
    const clock = makeClock();
    const gate = new CreateGate({ ...OPEN, CREATE_LIMIT_PER_IP_PER_HOUR: "2" }, clock.now);
    expect(gate.check("0x1000000000000000000000000000000000000001", "9.9.9.9").allowed).toBe(true);
    expect(gate.check("0x1000000000000000000000000000000000000002", "9.9.9.9").allowed).toBe(true);
    const denied = gate.check("0x1000000000000000000000000000000000000003", "9.9.9.9");
    expect(denied).toMatchObject({ allowed: false, reason: "ip_hourly" });
    // A different IP still passes: the per-IP dimension is the real bound.
    expect(gate.check("0x1000000000000000000000000000000000000004", "8.8.8.8").allowed).toBe(true);
  });

  it("denies on global_burst across creators AND ips (the operator breaker)", () => {
    const clock = makeClock();
    const gate = new CreateGate({ ...OPEN, CREATE_BURST_GLOBAL: "1" }, clock.now);
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    const denied = gate.check(B, "2.2.2.2");
    expect(denied).toMatchObject({ allowed: false, reason: "global_burst" });
  });

  it("global_burst rolls over after its window (injected clock)", () => {
    const clock = makeClock();
    const gate = new CreateGate({ ...OPEN, CREATE_BURST_GLOBAL: "1" }, clock.now);
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    expect(gate.check(B, "2.2.2.2").allowed).toBe(false);
    clock.advance(60_000);
    expect(gate.check(B, "2.2.2.2").allowed).toBe(true);
  });

  it("a denied request inserts NOTHING into any window (peek-all then commit-all)", () => {
    const clock = makeClock();
    // Global burst 1 (60s window) + creator daily 1 (24h window): B's first attempt is
    // denied by global_burst. If that denied attempt had committed B's creator_daily,
    // B would still be blocked after the global window rolls over.
    const gate = new CreateGate(
      { ...OPEN, CREATE_BURST_GLOBAL: "1", CREATE_LIMIT_PER_CREATOR_PER_DAY: "1" },
      clock.now,
    );
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    expect(gate.check(B, "2.2.2.2")).toMatchObject({ allowed: false, reason: "global_burst" });
    clock.advance(60_000);
    // The daily window (24h) has NOT rolled over; B passes only because the denied
    // attempt never consumed B's daily budget.
    expect(gate.check(B, "2.2.2.2").allowed).toBe(true);
  });

  it("keys creators case-insensitively", () => {
    const clock = makeClock();
    const gate = new CreateGate({ ...OPEN, CREATE_BURST_PER_CREATOR: "1" }, clock.now);
    expect(gate.check("0xAbCd000000000000000000000000000000000001", "1.1.1.1").allowed).toBe(true);
    const denied = gate.check("0xABCD000000000000000000000000000000000001", "2.2.2.2");
    expect(denied).toMatchObject({ allowed: false, reason: "creator_burst" });
  });

  it("first deny wins in window order (global before creator)", () => {
    const clock = makeClock();
    const gate = new CreateGate(
      { ...OPEN, CREATE_BURST_GLOBAL: "1", CREATE_BURST_PER_CREATOR: "1" },
      clock.now,
    );
    expect(gate.check(A, "1.1.1.1").allowed).toBe(true);
    // A again: both global_burst and creator_burst are at cap; global reports first.
    expect(gate.check(A, "1.1.1.1")).toMatchObject({ allowed: false, reason: "global_burst" });
  });
});
