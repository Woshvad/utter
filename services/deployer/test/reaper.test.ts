// reaper.test.ts - the pure runaway-container classifier (H4 / SPEC §9.5). No
// Docker: classifyRunaway is a pure verdict over an ActualContainer + policy + the
// prior consecutive high-CPU count, so every signal is a plain data assertion.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { classifyRunaway, DEFAULT_RUNAWAY_POLICY, type RunawayPolicy } from "../src/reaper";
import type { ActualContainer } from "../src/reconcile";

const RID: Hex = `0x${"7e".repeat(32)}`;

function container(over: Partial<ActualContainer> = {}): ActualContainer {
  return { id: "ctr-1", resourceId: RID, running: true, ...over };
}

const POLICY: RunawayPolicy = { maxRestartCount: 5, cpuFraction: 0.95, sustainedSamples: 3 };

describe("classifyRunaway - restart-loop signal", () => {
  it("trips at >= maxRestartCount", () => {
    const v = classifyRunaway(container({ restartCount: 5 }), POLICY, 0);
    expect(v.runaway).toBe(true);
    expect(v.reason).toContain("restart-loop");
    expect(v.reason).toContain("5");
  });

  it("does NOT trip below maxRestartCount", () => {
    const v = classifyRunaway(container({ restartCount: 4 }), POLICY, 0);
    expect(v.runaway).toBe(false);
    expect(v.reason).toBeUndefined();
  });

  it("treats a missing restartCount as 0 (not runaway)", () => {
    const v = classifyRunaway(container({}), POLICY, 0);
    expect(v.runaway).toBe(false);
  });

  it("takes precedence in the reason when both restart and CPU trip", () => {
    // restartCount over cap AND a sustained high CPU about to trip: restart wins.
    const v = classifyRunaway(container({ restartCount: 6, cpuFraction: 0.99 }), POLICY, 2);
    expect(v.runaway).toBe(true);
    expect(v.reason).toContain("restart-loop");
    expect(v.reason).not.toContain("cpu pegged");
    // The consecutive count is still advanced so the loop's per-container state stays correct.
    expect(v.consecutiveHighCpu).toBe(3);
  });
});

describe("classifyRunaway - sustained-CPU signal", () => {
  it("trips ONLY after sustainedSamples consecutive high observations", () => {
    const high = container({ cpuFraction: 0.96 });
    const v1 = classifyRunaway(high, POLICY, 0);
    expect(v1.runaway).toBe(false);
    expect(v1.consecutiveHighCpu).toBe(1);
    const v2 = classifyRunaway(high, POLICY, v1.consecutiveHighCpu);
    expect(v2.runaway).toBe(false);
    expect(v2.consecutiveHighCpu).toBe(2);
    const v3 = classifyRunaway(high, POLICY, v2.consecutiveHighCpu);
    expect(v3.runaway).toBe(true);
    expect(v3.reason).toContain("cpu pegged");
    expect(v3.consecutiveHighCpu).toBe(3);
  });

  it("RESETS the consecutive count on a below-threshold sample", () => {
    const high = container({ cpuFraction: 0.96 });
    const low = container({ cpuFraction: 0.5 });
    const v1 = classifyRunaway(high, POLICY, 0);
    expect(v1.consecutiveHighCpu).toBe(1);
    const v2 = classifyRunaway(high, POLICY, v1.consecutiveHighCpu);
    expect(v2.consecutiveHighCpu).toBe(2);
    // A dip resets the streak so a later high must start counting from scratch.
    const reset = classifyRunaway(low, POLICY, v2.consecutiveHighCpu);
    expect(reset.runaway).toBe(false);
    expect(reset.consecutiveHighCpu).toBe(0);
  });

  it("treats a missing cpuFraction as safe (the CPU signal stays dormant)", () => {
    // No cpuFraction on the container (the host adapter leaves it undefined this round).
    const v = classifyRunaway(container({}), POLICY, 2);
    expect(v.runaway).toBe(false);
    expect(v.consecutiveHighCpu).toBe(0);
  });

  it("is disabled when the policy omits cpuFraction/sustainedSamples", () => {
    const restartOnly: RunawayPolicy = { maxRestartCount: 5 };
    const v = classifyRunaway(container({ cpuFraction: 0.99 }), restartOnly, 10);
    expect(v.runaway).toBe(false);
    expect(v.consecutiveHighCpu).toBe(0);
  });
});

describe("DEFAULT_RUNAWAY_POLICY", () => {
  it("carries a positive restart cap and a CPU threshold (host-capacity numbers)", () => {
    expect(DEFAULT_RUNAWAY_POLICY.maxRestartCount).toBeGreaterThan(0);
    expect(DEFAULT_RUNAWAY_POLICY.cpuFraction).toBeGreaterThan(0);
    expect(DEFAULT_RUNAWAY_POLICY.sustainedSamples).toBeGreaterThan(0);
  });
});
