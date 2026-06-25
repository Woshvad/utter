// reconcile.test.ts - deployment-record store + health/reconcile loop (DEP-05).
//
// Three things under test:
//   1. InMemoryDeploymentStore persists {resourceId, agentId, slug, deployVersion,
//      status} and reads it back - it is the TEST DEFAULT for the DeploymentStore
//      interface (the Redis adapter implements the same contract).
//   2. reconcile(desired, actual) is a PURE diff: records in desired but missing
//      from actual need (re)launch (toLaunch); containers in actual but not desired
//      are orphans to reap (toReap, T-03-19); desired == actual -> no drift, healthy.
//   3. createReconcileLoop reads desired (store) + actual (injected listContainers,
//      normally dockerode) on each tick - asserted via spies, calling tick() ONCE
//      (no real interval, no live Docker).
import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import {
  InMemoryDeploymentStore,
  type DeploymentRecord,
} from "../src/stores/memory";
import {
  reconcile,
  createReconcileLoop,
  type ActualContainer,
} from "../src/reconcile";
import type { RunawayPolicy } from "../src/reaper";

const AGENT: Hex = `0x${"a9".repeat(32)}`;

function record(resourceId: Hex, over: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    resourceId,
    agentId: AGENT,
    slug: `slug-${resourceId.slice(2, 6)}`,
    deployVersion: 1,
    status: "running",
    updatedAt: Date.now(),
    ...over,
  };
}

/** A container in the actual (dockerode) state, labelled with its resourceId. */
function container(resourceId: Hex, over: Partial<ActualContainer> = {}): ActualContainer {
  return { id: `ctr-${resourceId.slice(2, 6)}`, resourceId, running: true, ...over };
}

describe("InMemoryDeploymentStore (DEP-05 test default)", () => {
  it("persists {resourceId, agentId, slug, deployVersion, status} and reads it back", async () => {
    const store = new InMemoryDeploymentStore();
    const r: Hex = `0x${"11".repeat(32)}`;
    const rec = record(r, { slug: "weather", deployVersion: 3, status: "running" });
    await store.put(rec);

    const got = await store.get(r);
    expect(got).not.toBeNull();
    expect(got!.resourceId).toBe(r);
    expect(got!.agentId).toBe(AGENT);
    expect(got!.slug).toBe("weather");
    expect(got!.deployVersion).toBe(3);
    expect(got!.status).toBe("running");

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.resourceId).toBe(r);
  });

  it("a redeploy bumps deployVersion while keeping agentId + slug fixed (DEP-04)", async () => {
    const store = new InMemoryDeploymentStore();
    const r: Hex = `0x${"22".repeat(32)}`;
    await store.put(record(r, { slug: "stable", deployVersion: 1 }));
    await store.put(record(r, { slug: "stable", deployVersion: 2 }));
    const got = await store.get(r);
    expect(got!.deployVersion).toBe(2);
    expect(got!.slug).toBe("stable");
    expect(got!.agentId).toBe(AGENT);
    // Still a single record (a redeploy updates in place, never duplicates).
    expect(await store.list()).toHaveLength(1);
  });
});

describe("reconcile (pure desired-vs-actual diff, DEP-05)", () => {
  it("flags desired records missing from actual as toLaunch", () => {
    const r1: Hex = `0x${"31".repeat(32)}`;
    const r2: Hex = `0x${"32".repeat(32)}`;
    const desired = [record(r1), record(r2)];
    const actual = [container(r1)]; // r2 has no container
    const result = reconcile(desired, actual);
    expect(result.toLaunch.map((d) => d.resourceId)).toEqual([r2]);
    expect(result.toReap).toEqual([]);
    expect(result.healthy).toBe(false);
  });

  it("flags actual containers not in desired as toReap orphans (T-03-19)", () => {
    const r1: Hex = `0x${"41".repeat(32)}`;
    const orphan: Hex = `0x${"42".repeat(32)}`;
    const desired = [record(r1)];
    const actual = [container(r1), container(orphan)];
    const result = reconcile(desired, actual);
    expect(result.toLaunch).toEqual([]);
    expect(result.toReap.map((c) => c.resourceId)).toEqual([orphan]);
    expect(result.healthy).toBe(false);
  });

  it("reports no drift (healthy) when desired == actual", () => {
    const r1: Hex = `0x${"51".repeat(32)}`;
    const r2: Hex = `0x${"52".repeat(32)}`;
    const desired = [record(r1), record(r2)];
    const actual = [container(r1), container(r2)];
    const result = reconcile(desired, actual);
    expect(result.toLaunch).toEqual([]);
    expect(result.toReap).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  it("treats a desired record whose container is NOT running as toLaunch", () => {
    const r1: Hex = `0x${"61".repeat(32)}`;
    const desired = [record(r1)];
    const actual = [{ ...container(r1), running: false }];
    const result = reconcile(desired, actual);
    expect(result.toLaunch.map((d) => d.resourceId)).toEqual([r1]);
    expect(result.healthy).toBe(false);
  });
});

describe("createReconcileLoop (DEP-05)", () => {
  it("tick() reads desired (store) + actual (injected listContainers) once", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"71".repeat(32)}`;
    await store.put(record(r1));

    const listSpy = vi.fn(async (): Promise<ActualContainer[]> => [container(r1)]);
    const listSpyStore = vi.spyOn(store, "list");

    const loop = createReconcileLoop({ store, listContainers: listSpy, intervalMs: 60_000 });
    const result = await loop.tick();

    // Both readers were consulted exactly once on the tick (no live timer spun).
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpyStore).toHaveBeenCalledTimes(1);
    // desired == actual -> healthy, no drift.
    expect(result.healthy).toBe(true);
    expect(result.toLaunch).toEqual([]);
    expect(result.toReap).toEqual([]);
  });

  it("tick() surfaces drift from the injected readers", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"81".repeat(32)}`;
    const orphan: Hex = `0x${"82".repeat(32)}`;
    await store.put(record(r1));

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [container(orphan)]);
    const loop = createReconcileLoop({ store, listContainers, intervalMs: 60_000 });
    const result = await loop.tick();

    expect(result.toLaunch.map((d) => d.resourceId)).toEqual([r1]);
    expect(result.toReap.map((c) => c.resourceId)).toEqual([orphan]);
    expect(result.healthy).toBe(false);
  });

  it("ENFORCES drift: reaps every orphan container via reapContainer (WR-04, T-03-19)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"91".repeat(32)}`;
    const orphan1: Hex = `0x${"92".repeat(32)}`;
    const orphan2: Hex = `0x${"93".repeat(32)}`;
    await store.put(record(r1));

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1),
      container(orphan1),
      container(orphan2),
    ]);
    const reaped: Hex[] = [];
    const reapContainer = vi.fn(async (c: ActualContainer) => {
      reaped.push(c.resourceId);
    });

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
    });
    const result = await loop.tick();

    // Both orphans were reaped (stopped+removed), the desired record was not.
    expect(reapContainer).toHaveBeenCalledTimes(2);
    expect(reaped.sort()).toEqual([orphan1, orphan2].sort());
    expect(result.toReap.map((c) => c.resourceId).sort()).toEqual([orphan1, orphan2].sort());
  });

  it("does NOT reap a container that has a desired record (only orphans are reaped)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"a1".repeat(32)}`;
    await store.put(record(r1));
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [container(r1)]);
    const reapContainer = vi.fn(async () => undefined);
    const loop = createReconcileLoop({ store, listContainers, intervalMs: 60_000, reapContainer });
    await loop.tick();
    expect(reapContainer).not.toHaveBeenCalled();
  });

  it("surfaces a reap failure via onError instead of swallowing it (WR-06)", async () => {
    const store = new InMemoryDeploymentStore();
    const orphan: Hex = `0x${"b2".repeat(32)}`;
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [container(orphan)]);
    const reapContainer = vi.fn(async () => {
      throw new Error("docker remove failed");
    });
    const errors: { phase: string; message: string }[] = [];
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    // The tick still resolves (a failed reap does not crash the loop) but the
    // failure is SURFACED, not dropped.
    await loop.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe("reap");
    expect(errors[0]?.message).toContain("docker remove failed");
  });

  it("WARNS via onError when orphans exist but no reapContainer hook is configured (loud gap)", async () => {
    const store = new InMemoryDeploymentStore();
    const orphan: Hex = `0x${"c3".repeat(32)}`;
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [container(orphan)]);
    const errors: { phase: string; message: string }[] = [];
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe("reap");
    expect(errors[0]?.message).toContain("no reapContainer enforcement hook");
  });

  it("ENFORCES drift: relaunches missing desired records via launchContainer", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"d4".repeat(32)}`;
    await store.put(record(r1));
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => []); // nothing running
    const launched: Hex[] = [];
    const launchContainer = vi.fn(async (rec: DeploymentRecord) => {
      launched.push(rec.resourceId);
    });
    const loop = createReconcileLoop({ store, listContainers, intervalMs: 60_000, launchContainer });
    await loop.tick();
    expect(launchContainer).toHaveBeenCalledTimes(1);
    expect(launched).toEqual([r1]);
  });

  it("start/stop manage the interval without throwing (no real tick asserted)", () => {
    const store = new InMemoryDeploymentStore();
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => []);
    const loop = createReconcileLoop({ store, listContainers, intervalMs: 60_000 });
    expect(() => loop.start()).not.toThrow();
    // Idempotent start (a second start does not double-schedule / throw).
    expect(() => loop.start()).not.toThrow();
    expect(() => loop.stop()).not.toThrow();
    // Idempotent stop.
    expect(() => loop.stop()).not.toThrow();
  });
});

describe("reconcile - status filter (only active records are desired-running, H4)", () => {
  it("a 'failed' record is NOT in toLaunch and its running container becomes toReap", () => {
    const r1: Hex = `0x${"f1".repeat(32)}`;
    const desired = [record(r1, { status: "failed" })];
    const actual = [container(r1)]; // a container still runs for the quarantined record
    const result = reconcile(desired, actual);
    // The failed record is excluded from desired-running: not relaunched ...
    expect(result.toLaunch).toEqual([]);
    // ... and its still-running container is now an orphan to reap (no reap->relaunch loop).
    expect(result.toReap.map((c) => c.resourceId)).toEqual([r1]);
  });

  it("a 'stopped' record is not relaunched", () => {
    const r1: Hex = `0x${"f2".repeat(32)}`;
    const desired = [record(r1, { status: "stopped" })];
    const actual: ActualContainer[] = []; // nothing running
    const result = reconcile(desired, actual);
    expect(result.toLaunch).toEqual([]);
    expect(result.toReap).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  it("a 'deploying' record IS desired-running (relaunched if no container)", () => {
    const r1: Hex = `0x${"f3".repeat(32)}`;
    const desired = [record(r1, { status: "deploying" })];
    const result = reconcile(desired, []);
    expect(result.toLaunch.map((d) => d.resourceId)).toEqual([r1]);
  });
});

describe("createReconcileLoop - runaway pass (H4 quarantine + reap)", () => {
  const POLICY: RunawayPolicy = { maxRestartCount: 5, cpuFraction: 0.95, sustainedSamples: 3 };

  it("quarantines (record -> failed) AND reaps a restart-loop-wedged container, surfaced as 'runaway'", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"e1".repeat(32)}`;
    await store.put(record(r1));

    const wedged = container(r1, { restartCount: 5 });
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [wedged]);
    const reaped: string[] = [];
    const reapContainer = vi.fn(async (c: ActualContainer) => {
      reaped.push(c.id);
    });
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: POLICY,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();

    // Quarantined: the record is now failed so a later reconcile will not relaunch it.
    const rec = await store.get(r1);
    expect(rec?.status).toBe("failed");
    // Reaped exactly once, via the runaway pass (NOT double-reaped by the orphan pass).
    expect(reapContainer).toHaveBeenCalledTimes(1);
    expect(reaped).toEqual([wedged.id]);
    // Surfaced as a runaway event (no secret material - reason is the restart-loop string).
    const runaway = errors.filter((e) => e.phase === "runaway");
    expect(runaway.length).toBeGreaterThanOrEqual(1);
    expect(runaway.some((e) => e.message.includes("restart-loop"))).toBe(true);
    // No orphan-pass "reap" event for the same container (no double reap).
    expect(errors.some((e) => e.phase === "reap")).toBe(false);
  });

  it("does NOT touch a healthy container (below the restart cap)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"e2".repeat(32)}`;
    await store.put(record(r1));
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1, { restartCount: 1 }),
    ]);
    const reapContainer = vi.fn(async () => undefined);
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: POLICY,
    });
    await loop.tick();
    expect(reapContainer).not.toHaveBeenCalled();
    expect((await store.get(r1))?.status).toBe("running");
  });

  it("quarantine HOLDS even when the reap itself throws (DEFECT 2)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"e3".repeat(32)}`;
    await store.put(record(r1)); // status "running"

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1, { restartCount: 5 }), // >= policy.maxRestartCount
    ]);
    const reapContainer = vi.fn(async () => {
      throw new Error("docker remove failed");
    });
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: POLICY,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();

    // Quarantine held DESPITE the reap throwing (no fail-open relaunch path).
    expect((await store.get(r1))!.status).toBe("failed");
    // The reap failure was surfaced as a runaway event, not swallowed.
    const runaway = errors.filter((e) => e.phase === "runaway");
    expect(runaway.some((e) => e.message.includes("docker remove failed"))).toBe(true);
  });

  it("does NOT reap when the quarantine store.put throws (DEFECT 1 fail-closed)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"e4".repeat(32)}`;
    await store.put(record(r1)); // status "running"
    // The quarantine put throws (a Redis hiccup under host stress).
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("store down"));

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1, { restartCount: 5 }),
    ]);
    const reapContainer = vi.fn(async () => undefined);
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: POLICY,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();

    // The container was NOT removed (safeToReap was false): it stays running,
    // relaunchable, so it is not left removed-but-relaunchable.
    expect(reapContainer).not.toHaveBeenCalled();
    // A "quarantine failed" runaway event was surfaced.
    const runaway = errors.filter((e) => e.phase === "runaway");
    expect(runaway.some((e) => e.message.includes("quarantine failed"))).toBe(true);
  });

  it("reaps a record-less runaway directly (safeToReap via the null branch)", async () => {
    const store = new InMemoryDeploymentStore();
    // No store.put: the container's resourceId has NO desired record.
    const r1: Hex = `0x${"e5".repeat(32)}`;
    const orphanRunaway = container(r1, { restartCount: 5 });
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [orphanRunaway]);
    const reaped: string[] = [];
    const reapContainer = vi.fn(async (c: ActualContainer) => {
      reaped.push(c.id);
    });
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: POLICY,
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    // No crash on the missing record.
    await loop.tick();

    // Reaped directly (null branch -> safeToReap true) and surfaced.
    expect(reaped).toEqual([orphanRunaway.id]);
    expect(errors.some((e) => e.phase === "runaway")).toBe(true);
  });
});

describe("createReconcileLoop - runaway sustained-CPU loop state (H4, DEFECT 3)", () => {
  const CPU_POLICY: RunawayPolicy = { maxRestartCount: 5, cpuFraction: 0.95, sustainedSamples: 3 };

  it("(a) accumulates the high-CPU streak across ticks and trips on sustainedSamples", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"a5".repeat(32)}`;
    await store.put(record(r1));

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1, { cpuFraction: 0.96 }),
    ]);
    const reapContainer = vi.fn(async () => undefined);
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: CPU_POLICY,
    });

    await loop.tick(); // streak 1
    expect(reapContainer).not.toHaveBeenCalled();
    await loop.tick(); // streak 2
    expect(reapContainer).not.toHaveBeenCalled();
    await loop.tick(); // streak 3 -> trips
    expect(reapContainer).toHaveBeenCalledTimes(1);
    expect((await store.get(r1))!.status).toBe("failed");
  });

  it("(b) a below-threshold sample RESETS the streak (persisted across ticks)", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"a6".repeat(32)}`;
    await store.put(record(r1));

    let cpu = 0.96;
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [
      container(r1, { cpuFraction: cpu }),
    ]);
    const reapContainer = vi.fn(async () => undefined);
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: CPU_POLICY,
    });

    cpu = 0.96;
    await loop.tick(); // streak 1
    cpu = 0.5;
    await loop.tick(); // RESET to 0
    cpu = 0.96;
    await loop.tick(); // streak 1 again - never reaches 3 consecutively
    expect(reapContainer).not.toHaveBeenCalled();
    expect((await store.get(r1))!.status).toBe("running");
  });

  it("(c) a disappeared container PRUNES its streak, restarting from 0 on re-appear", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"a7".repeat(32)}`;
    await store.put(record(r1));

    let present = true;
    const listContainers = vi.fn(async (): Promise<ActualContainer[]> =>
      present ? [container(r1, { cpuFraction: 0.96 })] : [],
    );
    const reapContainer = vi.fn(async () => undefined);
    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      reapContainer,
      runawayPolicy: CPU_POLICY,
    });

    present = true;
    await loop.tick(); // streak 1
    await loop.tick(); // streak 2
    present = false;
    await loop.tick(); // container gone -> Map entry pruned
    present = true;
    await loop.tick(); // re-appears -> streak restarts at 1, NOT 3
    expect(reapContainer).not.toHaveBeenCalled();
    expect((await store.get(r1))!.status).toBe("running");
  });
});

describe("createReconcileLoop - host concurrency cap (H4)", () => {
  it("defers ALL launches and surfaces a 'capacity' event when running is at the cap", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"d1".repeat(32)}`;
    const r2: Hex = `0x${"d2".repeat(32)}`;
    const running: Hex = `0x${"d9".repeat(32)}`;
    await store.put(record(r1));
    await store.put(record(r2));
    await store.put(record(running)); // already running, occupies the only slot

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => [container(running)]);
    const launched: Hex[] = [];
    const launchContainer = vi.fn(async (rec: DeploymentRecord) => {
      launched.push(rec.resourceId);
    });
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      launchContainer,
      maxConcurrent: 1, // one running already -> zero capacity
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();

    // Both pending records are deferred (nothing launched), and the deferral is loud.
    expect(launched).toEqual([]);
    const capacity = errors.filter((e) => e.phase === "capacity");
    expect(capacity).toHaveLength(1);
    expect(capacity[0]?.message).toContain("deferred");
  });

  it("launches exactly one when a single slot is free, deferring the rest", async () => {
    const store = new InMemoryDeploymentStore();
    const r1: Hex = `0x${"c1".repeat(32)}`;
    const r2: Hex = `0x${"c2".repeat(32)}`;
    await store.put(record(r1));
    await store.put(record(r2));

    const listContainers = vi.fn(async (): Promise<ActualContainer[]> => []); // nothing running
    const launched: Hex[] = [];
    const launchContainer = vi.fn(async (rec: DeploymentRecord) => {
      launched.push(rec.resourceId);
    });
    const errors: { phase: string; message: string }[] = [];

    const loop = createReconcileLoop({
      store,
      listContainers,
      intervalMs: 60_000,
      launchContainer,
      maxConcurrent: 1, // zero running -> exactly one slot
      onError: (e) => errors.push({ phase: e.phase, message: e.message }),
    });
    await loop.tick();

    // Exactly one launched (input order preserved), one deferred + surfaced.
    expect(launched).toEqual([r1]);
    expect(errors.filter((e) => e.phase === "capacity")).toHaveLength(1);
  });
});
