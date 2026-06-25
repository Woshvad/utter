// probe-wiring.test.ts - the PRX-02 egress assertion wiring (design §4.3).
//
// runEgressProbe replaces the old phantom POST to a /__egress-probe route (which
// 404'd -> a false PRX-02 pass) with the REAL blocked-host probe-runner the RUNBOOK
// documents: createLiveHostProbe over a GvisorRunner + assertBlocked. It is
// HOST-GATED:
//   - NO docker handle  -> SKIP (operator-gated log), return false (NOT a false pass).
//   - WITH a docker handle -> drive the genuine gVisor probe; every blocked host
//     unreachable -> resolve true; a reachable host -> ContainmentFailureError.
//
// AUTONOMOUS: no real daemon. The "with a handle" path injects a docker spy whose
// containers exit non-zero (a non-zero exit == the host was UNREACHABLE == the
// blocked-OK outcome), so assertBlocked resolves and we assert the wiring drove the
// spy. No live SSRF is ever attempted.
import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import { runEgressProbe, type DockerHandle } from "../src/live-deploy";

/**
 * A docker spy shaped to what GvisorRunner.run needs: createContainer ->
 * { id, start(), wait() -> { StatusCode } }. A non-zero StatusCode means the probe
 * container could NOT reach the target (the blocked-OK outcome), so assertBlocked
 * resolves. Records how many containers were launched (one per probe target).
 */
function mockDocker(statusCode = 1): { docker: DockerHandle; createContainer: ReturnType<typeof vi.fn> } {
  const wait = vi.fn(async () => ({ StatusCode: statusCode }));
  const start = vi.fn(async () => undefined);
  const createContainer = vi.fn(async () => ({ id: "probe-container", start, wait }) as unknown as Docker.Container);
  const docker = { createContainer } as unknown as DockerHandle;
  return { docker, createContainer };
}

describe("runEgressProbe - host gate (skip without a docker handle)", () => {
  it("SKIPS and returns false when no docker handle is available (operator-gated, NOT a false pass)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await runEgressProbe(undefined);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PRX-02 SKIPPED"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("operator-gated"));
    log.mockRestore();
  });
});

describe("runEgressProbe - real probe path (wired to createLiveHostProbe + GvisorRunner)", () => {
  it("drives the genuine gVisor probe when a docker handle is present (every host unreachable -> true)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { docker, createContainer } = mockDocker(1); // non-zero exit == unreachable == blocked OK

    const result = await runEgressProbe(docker);

    expect(result).toBe(true);
    // The real probe launched a probe container per target (the full EGRESS_BLOCK_SET
    // plus DEFAULT_PROBE_TARGETS) through the GvisorRunner -> dockerode seam. The old
    // phantom path made ZERO container launches (it just POSTed to a dead route).
    expect(createContainer).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PRX-02 OK"));
    log.mockRestore();
  });

  it("throws ContainmentFailureError when a blocked host is reachable (exit 0)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { docker } = mockDocker(0); // exit 0 == the host WAS reachable == containment failure

    await expect(runEgressProbe(docker)).rejects.toThrow(/containment/i);
    log.mockRestore();
  });
});
