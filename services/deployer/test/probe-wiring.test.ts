// probe-wiring.test.ts - the PRX-02 egress assertion wiring (design §4.3).
//
// runEgressProbe replaces the old phantom POST to a /__egress-probe route (which
// 404'd -> a false PRX-02 pass) with the REAL blocked-host probe-runner the RUNBOOK
// documents: createLiveHostProbe over a GvisorRunner + an injected connectProbe
// that launches the blocked-host probe image DIRECTLY via dockerode. It is
// HOST-GATED:
//   - NO docker handle  -> SKIP (operator-gated log), return false (NOT a false pass).
//   - WITH a docker handle but NO pairnet network -> throw (the probe attaches to the
//     handler's pairnet to test the handler's reachability).
//   - WITH a docker handle + network -> drive the genuine probe; every blocked
//     host unreachable -> resolve true; a reachable host -> ContainmentFailureError.
//
// AUTONOMOUS: no real daemon. The "with a handle" path injects a docker spy whose
// containers exit non-zero (a non-zero exit == the host was UNREACHABLE == the
// blocked-OK outcome), so assertBlocked resolves and we assert the wiring built a
// VALID createContainer spec (no `#host` tag, the target in Cmd, the pairnet
// NetworkMode). No live SSRF is ever attempted.
//
// HOST VALIDATION REQUIRED: the construction logic below is verified here, but the
// actual probe RUN (launching utter/blocked-host-probe on the handler's pairnet and
// observing real reachability) needs the provisioned gVisor host - it is NOT
// runtime-validated in this suite.
import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  runEgressProbe,
  buildProbeCreateOptions,
  BLOCKED_HOST_PROBE_IMAGE,
  type DockerHandle,
} from "../src/live-deploy";

const PAIRNET_NAME = "utter_pairnet_echo";

/**
 * A docker spy shaped to what the injected connectProbe needs: createContainer ->
 * { id, start(), wait() -> { StatusCode } }. A non-zero StatusCode means the probe
 * container could NOT reach the target (the blocked-OK outcome), so assertBlocked
 * resolves. Records every createContainer arg so the test can assert the spec is a
 * VALID dockerode create spec (no `#` in the image, the target in Cmd, the pairnet).
 */
function mockDocker(statusCode = 1): {
  docker: DockerHandle;
  createContainer: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  const wait = vi.fn(async () => ({ StatusCode: statusCode }));
  const start = vi.fn(async () => undefined);
  const createContainer = vi.fn(
    async () => ({ id: "probe-container", start, wait }) as unknown as Docker.Container,
  );
  const docker = { createContainer } as unknown as DockerHandle;
  return { docker, createContainer, start };
}

describe("buildProbeCreateOptions - the pure dockerode create spec (verifiable here)", () => {
  it("builds a VALID image reference (no `#host` suffix) with the target in Cmd", () => {
    const opts = buildProbeCreateOptions({ targetHost: "169.254.169.254", network: PAIRNET_NAME });
    // The image is the plain tag - NEVER `utter/blocked-host-probe:latest#169.254.169.254`,
    // which Docker rejects with "invalid reference format".
    expect(opts.Image).toBe(BLOCKED_HOST_PROBE_IMAGE);
    expect(opts.Image).not.toContain("#");
    // The dynamic target rides in Cmd (the locked RunSpec cannot carry it).
    expect(opts.Cmd).toEqual(["169.254.169.254"]);
  });

  it("attaches the probe to the handler's pairnet (NOT a container:<handler> netns share)", () => {
    const opts = buildProbeCreateOptions({ targetHost: "10.0.0.1", network: PAIRNET_NAME });
    // The pairnet name verbatim - the same internal no-gateway bridge as the handler,
    // so the same reachability. NEVER `container:<handler>` (a fragile netns share a
    // runc probe cannot observe across a runsc userspace netstack).
    expect(opts.HostConfig.NetworkMode).toBe(PAIRNET_NAME);
    expect(opts.HostConfig.NetworkMode).not.toContain("container:");
  });

  it("hardens the probe container (auto-remove, cap-drop, no-new-privileges, caps)", () => {
    const opts = buildProbeCreateOptions({ targetHost: "127.0.0.1", network: PAIRNET_NAME });
    expect(opts.HostConfig.AutoRemove).toBe(true);
    expect(opts.HostConfig.ReadonlyRootfs).toBe(true);
    expect(opts.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(opts.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(opts.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(opts.HostConfig.Memory).toBeGreaterThan(0);
  });
});

describe("runEgressProbe - host gate (skip without a docker handle, pairnet-attached probe)", () => {
  it("SKIPS and returns false when no docker handle is available (operator-gated, NOT a false pass)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await runEgressProbe(undefined);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PRX-02 SKIPPED"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("operator-gated"));
    log.mockRestore();
  });

  it("THROWS when a docker handle is present but no pairnet network is given (needs the handler's pairnet)", async () => {
    const { docker } = mockDocker(1);
    await expect(runEgressProbe(docker)).rejects.toThrow(/pairnet network/i);
  });
});

describe("runEgressProbe - real probe path (injected connectProbe -> dockerode)", () => {
  it("launches a probe container per target with a VALID spec (every host unreachable -> true)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { docker, createContainer } = mockDocker(1); // non-zero exit == unreachable == blocked OK

    const result = await runEgressProbe(docker, PAIRNET_NAME);

    expect(result).toBe(true);
    // The real probe launched a probe container per target (the full EGRESS_BLOCK_SET
    // plus DEFAULT_PROBE_TARGETS) through the injected connectProbe -> dockerode seam.
    expect(createContainer).toHaveBeenCalled();
    // Every create call carried a VALID spec: a plain image tag (no `#`), a Cmd that
    // carries the target host, and the handler's pairnet NetworkMode. The old code
    // built `${image}#${host}` which Docker rejected as an invalid reference.
    for (const call of createContainer.mock.calls) {
      const spec = call[0] as { Image: string; Cmd: string[]; HostConfig: { NetworkMode: string } };
      expect(spec.Image).toBe(BLOCKED_HOST_PROBE_IMAGE);
      expect(spec.Image).not.toContain("#");
      expect(Array.isArray(spec.Cmd)).toBe(true);
      expect(spec.Cmd).toHaveLength(1);
      expect(spec.HostConfig.NetworkMode).toBe(PAIRNET_NAME);
      expect(spec.HostConfig.NetworkMode).not.toContain("container:");
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PRX-02 OK"));
    log.mockRestore();
  });

  it("throws ContainmentFailureError when a blocked host is reachable (exit 0)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { docker } = mockDocker(0); // exit 0 == the host WAS reachable == containment failure

    await expect(runEgressProbe(docker, PAIRNET_NAME)).rejects.toThrow(/containment/i);
    log.mockRestore();
  });
});
