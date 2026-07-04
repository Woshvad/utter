// limits-fixed-window.test.ts - the shared fixed-window limiter (S1) + env guard.
//
// Covers: peek never mutates; commit counts against the window; the window rolls
// over with an injectable clock (no real-time sleeps); the deny verdict carries the
// real retryAfterMs; the hard key cap evicts the oldest window; expired entries are
// swept; and parsePositiveInt rejects the classic Number(env.X ?? D) footguns.
import { describe, it, expect, vi } from "vitest";
import {
  FixedWindowLimiter,
  parsePositiveInt,
} from "../app/limits/fixed-window.server";

/** A tiny controllable clock. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("parsePositiveInt (the shared env guard)", () => {
  it("returns the parsed positive integer", () => {
    expect(parsePositiveInt("5", 3, "X")).toBe(5);
    expect(parsePositiveInt(" 12 ", 3, "X")).toBe(12);
  });

  it("falls back silently when the variable is unset or empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parsePositiveInt(undefined, 7, "X")).toBe(7);
    expect(parsePositiveInt("", 7, "X")).toBe(7);
    expect(parsePositiveInt("   ", 7, "X")).toBe(7);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back with a warning on NaN, zero, and negative values (never fail-open)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parsePositiveInt("5O", 7, "X")).toBe(7); // the letter O, coerces to NaN
    expect(parsePositiveInt("0", 7, "X")).toBe(7);
    expect(parsePositiveInt("-3", 7, "X")).toBe(7);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("floors a fractional value", () => {
    expect(parsePositiveInt("2.9", 7, "X")).toBe(2);
  });
});

describe("FixedWindowLimiter", () => {
  it("peek does not mutate: repeated peeks never consume the limit", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 2, windowMs: 1000, now: clock.now });
    for (let i = 0; i < 10; i++) {
      expect(l.peek("k").allowed).toBe(true);
      expect(l.peek("k").remaining).toBe(2);
    }
  });

  it("commit counts and the limit denies with the window's retryAfterMs", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 2, windowMs: 1000, now: clock.now });
    l.commit("k");
    expect(l.peek("k")).toEqual({ allowed: true, retryAfterMs: 0, remaining: 1 });
    l.commit("k");
    clock.advance(400);
    const denied = l.peek("k");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // window started at t0, 400ms elapsed -> 600ms left.
    expect(denied.retryAfterMs).toBe(600);
  });

  it("rolls over at the window boundary (injected clock, no sleeps)", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now });
    l.commit("k");
    expect(l.peek("k").allowed).toBe(false);
    clock.advance(1000);
    expect(l.peek("k")).toEqual({ allowed: true, retryAfterMs: 0, remaining: 1 });
    l.commit("k");
    expect(l.peek("k").allowed).toBe(false);
  });

  it("keys are independent", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now });
    l.commit("a");
    expect(l.peek("a").allowed).toBe(false);
    expect(l.peek("b").allowed).toBe(true);
  });

  it("hard cap evicts the entry with the oldest windowStart, never exceeding maxKeys", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now, maxKeys: 3 });
    l.commit("a"); // oldest
    clock.advance(10);
    l.commit("b");
    clock.advance(10);
    l.commit("c");
    expect(l.size).toBe(3);
    clock.advance(10);
    l.commit("d"); // evicts "a"
    expect(l.size).toBe(3);
    // "a" behaves fresh again (its counter is gone); "b" is still at its limit.
    expect(l.peek("a").remaining).toBe(1);
    expect(l.peek("b").allowed).toBe(false);
  });

  it("sweeps expired entries lazily on access", () => {
    const clock = makeClock();
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now });
    l.commit("a");
    l.commit("b");
    expect(l.size).toBe(2);
    // Past the window AND past the sweep throttle: the next access sweeps.
    clock.advance(2000);
    l.commit("c");
    expect(l.size).toBe(1);
  });
});
