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
function container(resourceId: Hex): ActualContainer {
  return { id: `ctr-${resourceId.slice(2, 6)}`, resourceId, running: true };
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
