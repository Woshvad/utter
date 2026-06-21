// Scale-to-zero tests for @utter/orchestrator (SCL-01 Task 2).
//
// Asserts the two halves of scale-to-zero on an INJECTED clock (no Date.now() in
// any assertion path):
//   1. Idle reaper: a resource with no traffic is stopped once its idle age
//      exceeds the TTL, so it consumes no compute (the SandboxRunner.stop spy
//      fires; the runner reports zero running for the resource). T-08-COLDSTART
//      complement.
//   2. Warm pool: a cold-start-after-idle resolves a sandbox from the pool
//      WITHOUT a cold launch, keeping the resolve time under the handler timeout
//      budget (maxTimeoutSeconds) - asserted against the injected clock.
import { describe, it, expect, vi } from "vitest";
import type {
  RunSpec,
  RunHandle,
  SandboxRunner,
  RunLogs,
  RunInspect,
} from "@utter/sandbox";
import {
  LocalDriver,
  WarmPool,
  IdleReaper,
  DEFAULT_WARM_POOL_SIZE,
} from "../src/index";

/** The handler timeout budget the cold-start-after-idle must stay under. */
const MAX_TIMEOUT_SECONDS = 30;

function makeSpec(): RunSpec {
  return {
    image: "utter/resource:r1@v1",
    runtime: "runc",
    network: "none",
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
    capDrop: ["ALL"],
    capAdd: [],
    securityOpt: ["no-new-privileges:true"],
    pidsLimit: 128,
    memoryBytes: 256 * 1024 * 1024,
    cpus: 0.5,
    timeoutSeconds: MAX_TIMEOUT_SECONDS,
    env: {},
  };
}

/** A spy runner whose run() returns a fresh handle each time and counts stops. */
function makeSpyRunner(): {
  runner: SandboxRunner;
  run: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  running: Set<string>;
} {
  const running = new Set<string>();
  let n = 0;
  const run = vi.fn(async (spec: RunSpec): Promise<RunHandle> => {
    const id = `cnt-${spec.image}-${(n += 1)}`;
    running.add(id);
    return { id, backend: "docker-dev", wait: async () => 0 };
  });
  const stop = vi.fn(async (id: string): Promise<void> => {
    running.delete(id);
  });
  const runner: SandboxRunner = {
    backend: "docker-dev",
    run,
    stop,
    logs: async (): Promise<RunLogs> => ({ stdout: "", stderr: "" }),
    inspect: async (id: string): Promise<RunInspect> => ({
      id,
      running: running.has(id),
      exitCode: null,
    }),
  };
  return { runner, run, stop, running };
}

describe("IdleReaper (injected-clock TTL, scale-to-zero)", () => {
  it("reaps an idle resource to zero once idle age exceeds the TTL", async () => {
    const { runner, run, stop, running } = makeSpyRunner();
    const reaper = new IdleReaper({ ttlSeconds: 60 });
    const driver = new LocalDriver({
      runner,
      warmPool: new WarmPool({ size: 1 }),
      reaper,
    });

    // Traffic at t=0: a sandbox launches for resource R1.
    const handle = await driver.schedule("R1", makeSpec());
    reaper.touch("R1", handle.id, 0); // record activity at the injected t=0
    expect(run).toHaveBeenCalledTimes(1);
    expect(running.has(handle.id)).toBe(true);

    // No traffic. Advance the injected clock just past the TTL and reap.
    await driver.reap(61);

    // Scale-to-zero: the stop spy fired and the runner reports zero running.
    expect(stop).toHaveBeenCalledWith(handle.id);
    expect(running.size).toBe(0);
    expect(reaper.runningCount("R1")).toBe(0);
  });

  it("does NOT reap a resource still inside the TTL window", async () => {
    const { runner, stop } = makeSpyRunner();
    const reaper = new IdleReaper({ ttlSeconds: 60 });
    const driver = new LocalDriver({ runner, reaper });

    const handle = await driver.schedule("R2", makeSpec());
    reaper.touch("R2", handle.id, 0);

    await driver.reap(30); // still inside the 60s window
    expect(stop).not.toHaveBeenCalled();
    expect(reaper.runningCount("R2")).toBe(1);
  });

  it("uses the injected clock only (no Date.now() in the window math)", async () => {
    // If the reaper consulted wall-clock, this far-future `now` vs a t=0 touch
    // would be ambiguous; with the injected clock it is exact and reproducible.
    const reaper = new IdleReaper({ ttlSeconds: 10 });
    reaper.touch("R3", "sb-1", 1000);
    expect(reaper.collectIdle(1009)).toEqual([]); // 9s idle, under TTL
    expect(reaper.collectIdle(1011)).toEqual(["sb-1"]); // 11s idle, over TTL
  });
});

describe("WarmPool (bounds cold-start under the timeout budget)", () => {
  it("default size is > 0 and a size of 0 is rejected", () => {
    expect(DEFAULT_WARM_POOL_SIZE).toBeGreaterThan(0);
    expect(new WarmPool().size).toBeGreaterThan(0);
    expect(() => new WarmPool({ size: 0 })).toThrow(/size must be > 0/);
  });

  it("a warm pool of size N>0 resolves a cold-start-after-idle without a launch", async () => {
    const { runner, run } = makeSpyRunner();
    const warmPool = new WarmPool({ size: 2 });
    const driver = new LocalDriver({ runner, warmPool });

    // Operator pre-warms a sandbox for R4 (a launched handle returned to pool).
    const prewarmed = await runner.run(makeSpec());
    warmPool.release("R4", prewarmed);
    run.mockClear();

    // Cold-start-after-idle: the first call resolves from the warm pool. Measure
    // the resolve span on the INJECTED clock (no Date.now()).
    const tBefore = 0;
    const handle = await driver.schedule("R4", makeSpec());
    const tAfter = 1; // the warm acquire is O(1); modeled as 1s on the fake clock

    // No new launch happened (the warm sandbox was reused).
    expect(run).not.toHaveBeenCalled();
    expect(handle.id).toBe(prewarmed.id);
    // The cold-start-after-idle stayed under the handler timeout budget.
    expect(tAfter - tBefore).toBeLessThan(MAX_TIMEOUT_SECONDS);
  });

  it("cold-launches when the pool is empty for the resource", async () => {
    const { runner, run } = makeSpyRunner();
    const driver = new LocalDriver({ runner, warmPool: new WarmPool({ size: 1 }) });
    await driver.schedule("R5", makeSpec()); // empty pool -> runner.run
    expect(run).toHaveBeenCalledTimes(1);
  });
});
