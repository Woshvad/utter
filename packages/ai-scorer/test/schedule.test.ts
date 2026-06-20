// schedule.test.ts - the scheduled re-scoring loop (SCR-01 schedule half).
//
// Proves with a FAKE clock (no real timers): tick() probes each tracked resource
// via the injected ResourceProber, applies reduceStrike per resource, and invokes
// applyResult for the deactivation side-effects (index/pause/slash-review) - keeping
// the side-effects OUTSIDE the pure reducer; start() is idempotent and the interval
// is unref'd (never keeps the process alive); stop() clears the timer; a prober
// error routes to onError without leaking secrets; and the barrel re-exports the
// public surface.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createScoringLoop, type ApplyResultEvent } from "../src/schedule";
import { FixtureProber, type ProbeResult } from "../src/prober";
import { initialStrikeState } from "../src/strikes";
import * as barrel from "../src/index";

const PASS: ProbeResult = {
  passed: true,
  schemaOk: true,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 10,
};
const FAIL: ProbeResult = {
  passed: false,
  schemaOk: false,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 10,
  reason: "schema",
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createScoringLoop tick (probe + reduce + applyResult)", () => {
  it("probes each tracked resource and applies the reducer on a tick", async () => {
    const prober = new FixtureProber(PASS);
    const states = new Map([["0xa", initialStrikeState()]]);
    const applied: ApplyResultEvent[] = [];
    const loop = createScoringLoop({
      prober,
      resources: () => [{ resourceId: "0xa" }],
      getState: (id) => states.get(id) ?? initialStrikeState(),
      setState: (id, s) => void states.set(id, s),
      applyResult: (e) => void applied.push(e),
      intervalMs: 1000,
    });

    await loop.tick();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.resourceId).toBe("0xa");
    expect(applied[0]!.result.passed).toBe(true);
    // The state advanced (one probe folded).
    expect(states.get("0xa")!.probeCount).toBe(1);
  });

  it("fires applyResult with a deactivation transition on the 5th consecutive failure", async () => {
    const prober = new FixtureProber(FAIL);
    const states = new Map([["0xa", initialStrikeState()]]);
    const deactivations: ApplyResultEvent[] = [];
    const loop = createScoringLoop({
      prober,
      resources: () => [{ resourceId: "0xa" }],
      getState: (id) => states.get(id) ?? initialStrikeState(),
      setState: (id, s) => void states.set(id, s),
      applyResult: (e) => {
        if (e.transition.deactivated) deactivations.push(e);
      },
      intervalMs: 1000,
    });

    // Five ticks -> the 5th is the deactivation.
    for (let i = 0; i < 5; i++) await loop.tick();
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0]!.transition.bondSlashReview?.resourceId).toBe("0xa");
    expect(states.get("0xa")!.active).toBe(false);
  });

  it("a single passing tick after a 4-failure blip keeps the resource active", async () => {
    const states = new Map([["0xa", initialStrikeState()]]);
    function makeLoop(prober: FixtureProber) {
      return createScoringLoop({
        prober,
        resources: () => [{ resourceId: "0xa" }],
        getState: (id) => states.get(id) ?? initialStrikeState(),
        setState: (id, s) => void states.set(id, s),
        applyResult: () => {},
        intervalMs: 1000,
      });
    }
    const failing = makeLoop(new FixtureProber(FAIL));
    for (let i = 0; i < 4; i++) await failing.tick();
    await makeLoop(new FixtureProber(PASS)).tick();
    expect(states.get("0xa")!.active).toBe(true);
    expect(states.get("0xa")!.consecutiveFailures).toBe(0);
  });
});

describe("createScoringLoop start/stop (fake clock)", () => {
  it("start ticks on the interval; stop clears the timer", async () => {
    const prober = new FixtureProber(PASS);
    let ticks = 0;
    const loop = createScoringLoop({
      prober,
      resources: () => [{ resourceId: "0xa" }],
      getState: () => initialStrikeState(),
      setState: () => {},
      applyResult: () => {
        ticks += 1;
      },
      intervalMs: 1000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toBe(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(3); // no more ticks after stop
  });

  it("start is idempotent (a second start does not double the cadence)", async () => {
    const prober = new FixtureProber(PASS);
    let ticks = 0;
    const loop = createScoringLoop({
      prober,
      resources: () => [{ resourceId: "0xa" }],
      getState: () => initialStrikeState(),
      setState: () => {},
      applyResult: () => {
        ticks += 1;
      },
      intervalMs: 1000,
    });
    loop.start();
    loop.start(); // no-op
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toBe(2);
    loop.stop();
  });

  it("stop is idempotent (calling it twice is safe)", () => {
    const loop = createScoringLoop({
      prober: new FixtureProber(PASS),
      resources: () => [],
      getState: () => initialStrikeState(),
      setState: () => {},
      applyResult: () => {},
      intervalMs: 1000,
    });
    expect(() => {
      loop.stop();
      loop.stop();
    }).not.toThrow();
  });
});

describe("createScoringLoop error routing (no secret leak)", () => {
  it("routes a prober error to onError without crashing the loop", async () => {
    const throwingProber = {
      backend: "fixture" as const,
      probe: async () => {
        throw new Error("probe boom");
      },
    };
    const errors: string[] = [];
    const loop = createScoringLoop({
      prober: throwingProber,
      resources: () => [{ resourceId: "0xa" }],
      getState: () => initialStrikeState(),
      setState: () => {},
      applyResult: () => {},
      intervalMs: 1000,
      onError: (e) => void errors.push(e.message),
    });

    await loop.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/probe boom/);
  });

  it("a thrown tick under start() is surfaced via onError, not swallowed", async () => {
    const throwingProber = {
      backend: "fixture" as const,
      probe: async () => {
        throw new Error("interval boom");
      },
    };
    const errors: string[] = [];
    const loop = createScoringLoop({
      prober: throwingProber,
      resources: () => [{ resourceId: "0xa" }],
      getState: () => initialStrikeState(),
      setState: () => {},
      applyResult: () => {},
      intervalMs: 1000,
      onError: (e) => void errors.push(e.message),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    loop.stop();
  });
});

describe("the @utter/ai-scorer barrel exports the public surface", () => {
  it("re-exports the prober, probe, reducer, and loop", () => {
    expect(barrel.FixtureProber).toBeDefined();
    expect(barrel.LiveHttpsProber).toBeDefined();
    expect(barrel.selectProber).toBeTypeOf("function");
    expect(barrel.runProbe).toBeTypeOf("function");
    expect(barrel.probeSchema).toBeTypeOf("function");
    expect(barrel.reduceStrike).toBeTypeOf("function");
    expect(barrel.initialStrikeState).toBeTypeOf("function");
    expect(barrel.STRIKE_LIMIT).toBe(5);
    expect(barrel.createScoringLoop).toBeTypeOf("function");
  });
});
