// concurrency.test.ts - the pure global-host concurrency-cap admission helper (H4 /
// SPEC §9.5). No Docker, no store: admitLaunches is a pure slice at the remaining
// host capacity, so every case is a plain data assertion.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { admitLaunches, DEFAULT_MAX_CONCURRENT_RESOURCES } from "../src/concurrency";
import type { DeploymentRecord } from "../src/stores/memory";

const AGENT: Hex = `0x${"a9".repeat(32)}`;

function record(resourceId: Hex): DeploymentRecord {
  return {
    resourceId,
    agentId: AGENT,
    slug: `slug-${resourceId.slice(2, 6)}`,
    deployVersion: 1,
    status: "running",
    updatedAt: 0,
  };
}

const ids = (rs: DeploymentRecord[]) => rs.map((r) => r.resourceId);

function records(n: number): DeploymentRecord[] {
  return Array.from({ length: n }, (_, i) =>
    record(`0x${i.toString(16).padStart(2, "0").repeat(32)}` as Hex),
  );
}

describe("admitLaunches (pure host concurrency cap, H4 / SPEC §9.5)", () => {
  it("admits ALL when there is room for every requested launch", () => {
    const toLaunch = records(3);
    const { admit, deferred } = admitLaunches({ toLaunch, runningCount: 0, maxConcurrent: 10 });
    expect(ids(admit)).toEqual(ids(toLaunch));
    expect(deferred).toEqual([]);
  });

  it("admits a PARTIAL prefix and defers the rest when capacity is limited", () => {
    const toLaunch = records(5);
    // cap 10, already 8 running -> 2 slots free.
    const { admit, deferred } = admitLaunches({ toLaunch, runningCount: 8, maxConcurrent: 10 });
    expect(ids(admit)).toEqual(ids(toLaunch.slice(0, 2)));
    expect(ids(deferred)).toEqual(ids(toLaunch.slice(2)));
  });

  it("defers ALL when running == cap (zero capacity)", () => {
    const toLaunch = records(3);
    const { admit, deferred } = admitLaunches({ toLaunch, runningCount: 10, maxConcurrent: 10 });
    expect(admit).toEqual([]);
    expect(ids(deferred)).toEqual(ids(toLaunch));
  });

  it("defers ALL when running EXCEEDS the cap (negative capacity floors at 0)", () => {
    const toLaunch = records(2);
    const { admit, deferred } = admitLaunches({ toLaunch, runningCount: 12, maxConcurrent: 10 });
    expect(admit).toEqual([]);
    expect(ids(deferred)).toEqual(ids(toLaunch));
  });

  it("preserves input order in both admit and deferred (no sort)", () => {
    const toLaunch = records(4);
    const { admit, deferred } = admitLaunches({ toLaunch, runningCount: 9, maxConcurrent: 10 });
    // Exactly one slot free: the FIRST record is admitted, the rest deferred in order.
    expect(ids(admit)).toEqual([toLaunch[0]!.resourceId]);
    expect(ids(deferred)).toEqual([
      toLaunch[1]!.resourceId,
      toLaunch[2]!.resourceId,
      toLaunch[3]!.resourceId,
    ]);
  });

  it("throws on a non-positive cap", () => {
    expect(() => admitLaunches({ toLaunch: records(1), runningCount: 0, maxConcurrent: 0 })).toThrow(
      /maxConcurrent/,
    );
    expect(() => admitLaunches({ toLaunch: records(1), runningCount: 0, maxConcurrent: -1 })).toThrow(
      /maxConcurrent/,
    );
  });

  it("exposes a positive operator-tunable default cap (host-capacity number)", () => {
    expect(DEFAULT_MAX_CONCURRENT_RESOURCES).toBeGreaterThan(0);
  });
});
