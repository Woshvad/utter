// strikes.test.ts - the pure 5-CONSECUTIVE-failure reducer (SCR-02/03).
//
// Proves: (1) reduceStrike is pure (same inputs -> same output, no mutation of the
// passed state); (2) 4 consecutive failures keep active=true, the 5th flips it
// false and raises a deactivation transition carrying a bond-slash-review signal
// driven OUTSIDE the reducer; (3) a single success after N<5 failures resets the
// consecutive counter (Pitfall 6 - CONSECUTIVE, never a lifetime total, so a
// transient blip does not deactivate a healthy endpoint); (4) a success when
// already inactive does NOT auto-reactivate; (5) the rollingScore updates
// monotonically from the probe stream.
import { describe, it, expect } from "vitest";
import {
  reduceStrike,
  initialStrikeState,
  STRIKE_LIMIT,
  type StrikeState,
  type BondSlashReview,
} from "../src/strikes";
import type { ProbeResult } from "../src/prober";

const PASS: ProbeResult = {
  passed: true,
  schemaOk: true,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 50,
};
const FAIL: ProbeResult = {
  passed: false,
  schemaOk: false,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 50,
  reason: "schema: response classified as malfunction",
};

/** Fold a probe stream through reduceStrike from the initial state. */
function fold(stream: ProbeResult[], resourceId = "0xabc"): StrikeState {
  return stream.reduce((s, p) => reduceStrike(s, p, resourceId).state, initialStrikeState());
}

describe("reduceStrike (pure 5-consecutive-failure reducer)", () => {
  it("STRIKE_LIMIT is 5", () => {
    expect(STRIKE_LIMIT).toBe(5);
  });

  it("starts active with zero consecutive failures", () => {
    const s = initialStrikeState();
    expect(s.active).toBe(true);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("increments consecutiveFailures on a failing probe", () => {
    const { state } = reduceStrike(initialStrikeState(), FAIL, "0xabc");
    expect(state.consecutiveFailures).toBe(1);
    expect(state.active).toBe(true);
  });

  it("4 consecutive failures keep active true (not yet deactivated)", () => {
    const s = fold([FAIL, FAIL, FAIL, FAIL]);
    expect(s.consecutiveFailures).toBe(4);
    expect(s.active).toBe(true);
    expect(s.deactivatedAtProbe).toBeUndefined();
  });

  it("the 5th consecutive failure flips active false and marks the deactivation", () => {
    const stream = [FAIL, FAIL, FAIL, FAIL];
    const before = fold(stream);
    const { state, transition } = reduceStrike(before, FAIL, "0xabc");
    expect(state.consecutiveFailures).toBe(5);
    expect(state.active).toBe(false);
    expect(state.deactivatedAtProbe).toBe(5);
    // The deactivation transition is the loop's cue to drive side-effects.
    expect(transition.deactivated).toBe(true);
    expect(transition.bondSlashReview).toBeDefined();
  });

  it("a single success after N<5 failures resets the consecutive counter (Pitfall 6)", () => {
    // A transient 4-failure blip then a green probe must NOT deactivate.
    const s = fold([FAIL, FAIL, FAIL, FAIL, PASS]);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.active).toBe(true);
    expect(s.deactivatedAtProbe).toBeUndefined();
  });

  it("CONSECUTIVE, not cumulative: 4 fails + pass + 4 fails stays active", () => {
    // 8 lifetime failures but never 5 in a row -> a healthy endpoint stays verified.
    const s = fold([FAIL, FAIL, FAIL, FAIL, PASS, FAIL, FAIL, FAIL, FAIL]);
    expect(s.active).toBe(true);
    expect(s.consecutiveFailures).toBe(4);
  });

  it("a passing probe with no prior failures keeps active and a zero counter", () => {
    const { state, transition } = reduceStrike(initialStrikeState(), PASS, "0xabc");
    expect(state.active).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(transition.deactivated).toBe(false);
    expect(transition.bondSlashReview).toBeUndefined();
  });

  it("the deactivation transition fires only ON the 5th failure, not on later failures", () => {
    const five = fold([FAIL, FAIL, FAIL, FAIL, FAIL]);
    expect(five.active).toBe(false);
    // A 6th failure while already inactive must not re-raise a fresh bond-slash-review.
    const { state, transition } = reduceStrike(five, FAIL, "0xabc");
    expect(state.active).toBe(false);
    expect(transition.deactivated).toBe(false);
    expect(transition.bondSlashReview).toBeUndefined();
  });

  it("a success when already inactive does NOT auto-reactivate", () => {
    const five = fold([FAIL, FAIL, FAIL, FAIL, FAIL]);
    expect(five.active).toBe(false);
    const { state } = reduceStrike(five, PASS, "0xabc");
    // Reactivation is an explicit external decision, never automatic.
    expect(state.active).toBe(false);
    // The counter still resets so a future re-activation starts clean.
    expect(state.consecutiveFailures).toBe(0);
  });

  it("the bond-slash-review carries the resourceId and the strike window", () => {
    const before = fold([FAIL, FAIL, FAIL, FAIL]);
    const { transition } = reduceStrike(before, FAIL, "0xdeadbeef");
    const review = transition.bondSlashReview as BondSlashReview;
    expect(review.resourceId).toBe("0xdeadbeef");
    expect(review.reason).toMatch(/consecutive/i);
    expect(review.consecutiveFailures).toBe(5);
  });

  it("is PURE: it does not mutate the input state", () => {
    const s = fold([FAIL, FAIL]);
    const snapshot = JSON.parse(JSON.stringify(s));
    reduceStrike(s, FAIL, "0xabc");
    expect(s).toEqual(snapshot);
  });

  it("rollingScore stays within [0,1] and rises on success, falls on failure", () => {
    const start = initialStrikeState();
    const afterFail = reduceStrike(start, FAIL, "0xabc").state;
    const afterPass = reduceStrike(afterFail, PASS, "0xabc").state;
    expect(afterFail.rollingScore).toBeLessThanOrEqual(start.rollingScore);
    expect(afterPass.rollingScore).toBeGreaterThanOrEqual(afterFail.rollingScore);
    expect(afterPass.rollingScore).toBeGreaterThanOrEqual(0);
    expect(afterPass.rollingScore).toBeLessThanOrEqual(1);
  });

  it("a long healthy stream drives rollingScore toward 1", () => {
    const s = fold(Array.from({ length: 20 }, () => PASS));
    expect(s.rollingScore).toBeGreaterThan(0.9);
  });
});
