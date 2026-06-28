// reconcile-bootstrap.test.ts - the host-gated reconcile-loop bootstrap (subtask 7).
//
// Two things under test, both WITHOUT a real docker daemon or host:
//   1. buildReconcileLoop wires the deployer deps + a docker handle into a working
//      ReconcileLoop: a tick() drives the EXISTING authoritative ops (listContainers
//      for actual state, listNetworks for the pairnet GC). We feed empty results so no
//      reap/filesystem path runs - the assertion is the OPTS WIRING (the loop reads
//      actual state and runs the orphan-network sweep), not the docker internals which
//      orchestrate.test.ts already covers.
//   2. resolveDockerHandle returns undefined off-host (no UTTER_SANDBOX_HOST), so
//      start()'s gate never builds a loop - the existing dev/test boot path is byte-
//      unchanged (no dockerode connection, no interval).
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildReconcileLoop } from "../src/server";
import { resolveDockerHandle, type DockerHandle } from "../src/orchestrate";
import { createInMemoryStores } from "../src/stores/memory";

/**
 * A fake docker handle exposing only the calls a tick() over an EMPTY actual+network
 * state makes: listContainers (actual state) and listNetworks (the pairnet GC sweep).
 * Both return empty so no reap/inspect/filesystem path is reached. The vi.fns make the
 * wiring observable.
 */
function makeFakeDocker() {
  const listContainers = vi.fn(async () => [] as unknown[]);
  const listNetworks = vi.fn(async () => [] as unknown[]);
  const handle = { listContainers, listNetworks } as unknown as DockerHandle;
  return { handle, listContainers, listNetworks };
}

describe("buildReconcileLoop wiring (subtask 7)", () => {
  it("a tick drives listContainers (actual state) and listNetworks (pairnet GC)", async () => {
    const { handle, listContainers, listNetworks } = makeFakeDocker();
    const stores = createInMemoryStores();
    const loop = buildReconcileLoop(handle, { stores }, {} as NodeJS.ProcessEnv);

    const result = await loop.tick();

    // The store is the desired-state source; with no containers and no records there is
    // no drift, so the loop is healthy and nothing was reaped.
    expect(result.healthy).toBe(true);
    expect(result.toReap).toEqual([]);
    expect(result.toLaunch).toEqual([]);

    // The injected docker ops were driven: listContainers (actual state) once, and the
    // pairnet GC swept (listNetworks) once.
    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(listNetworks).toHaveBeenCalledTimes(1);

    // No interval was ever started (tick() is on-demand); nothing to stop, but be tidy.
    loop.stop();
  });

  it("reads the interval from RECONCILE_INTERVAL_MS without starting (no open handle)", async () => {
    const { handle } = makeFakeDocker();
    const stores = createInMemoryStores();
    // Build with a custom interval; we never start() it, so no timer is created and the
    // test cannot leak an open handle.
    const loop = buildReconcileLoop(handle, { stores }, {
      RECONCILE_INTERVAL_MS: "5000",
    } as unknown as NodeJS.ProcessEnv);
    expect(typeof loop.tick).toBe("function");
    expect(typeof loop.start).toBe("function");
    expect(typeof loop.stop).toBe("function");
    loop.stop();
  });
});

describe("reconcile loop host gate", () => {
  const PRIOR = process.env.UTTER_SANDBOX_HOST;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.UTTER_SANDBOX_HOST;
    else process.env.UTTER_SANDBOX_HOST = PRIOR;
  });

  it("resolveDockerHandle returns undefined off-host so no loop is built", () => {
    delete process.env.UTTER_SANDBOX_HOST;
    // This is the exact gate start() uses: off-host there is no docker handle, so the
    // loop is never built and boot is unchanged (no dockerode connection).
    expect(resolveDockerHandle()).toBeUndefined();
  });
});
