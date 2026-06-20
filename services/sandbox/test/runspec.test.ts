// runspec.test.ts - the PURE run-spec invariant assertions (SBX-01/04).
//
// These tests launch NO container. They assert the security-relevant invariants
// of `buildRunSpec` for BOTH backends: the produced spec NEVER carries
// privileged, host networking, any capAdd, or a non-empty env, and the gvisor
// backend always maps to runtime "runsc" (docker-dev -> "runc", NOT a boundary).
import { describe, expect, it } from "vitest";
import { buildRunSpec, type RunLimits } from "../src/runner/runspec";
import type { RunBackend } from "../src/runner/types";

const LIMITS: RunLimits = {
  pidsLimit: 128,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 0.5,
  storageOptSize: "512m",
};

const build = (backend: RunBackend) =>
  buildRunSpec({ backend, image: "resource:abc123", limits: LIMITS, maxTimeoutSeconds: 30 });

describe("runspec - backend -> runtime mapping", () => {
  it("gvisor backend yields runtime 'runsc' + the hardened flags", () => {
    const spec = build("gvisor");
    expect(spec.runtime).toBe("runsc");
    expect(spec.network).toBe("none");
    expect(spec.readonlyRootfs).toBe(true);
    expect(spec.capDrop).toEqual(["ALL"]);
    expect(spec.securityOpt).toEqual(["no-new-privileges:true"]);
    expect(spec.pidsLimit).toBeGreaterThan(0);
    expect(spec.memoryBytes).toBeGreaterThan(0);
    expect(spec.cpus).toBeGreaterThan(0);
    expect(spec.timeoutSeconds).toBe(30);
  });

  it("docker-dev backend yields runtime 'runc' with IDENTICAL hardening (NOT a boundary)", () => {
    const spec = build("docker-dev");
    expect(spec.runtime).toBe("runc");
    // Same hardening flags as gvisor; only the runtime differs.
    expect(spec.network).toBe("none");
    expect(spec.readonlyRootfs).toBe(true);
    expect(spec.capDrop).toEqual(["ALL"]);
    expect(spec.securityOpt).toEqual(["no-new-privileges:true"]);
  });

  it("timeoutSeconds == maxTimeoutSeconds", () => {
    const spec = buildRunSpec({
      backend: "gvisor",
      image: "resource:abc",
      limits: LIMITS,
      maxTimeoutSeconds: 17,
    });
    expect(spec.timeoutSeconds).toBe(17);
  });
});

describe("runspec - security invariants (BOTH backends)", () => {
  for (const backend of ["gvisor", "docker-dev"] as const) {
    describe(backend, () => {
      const spec = build(backend) as unknown as Record<string, unknown>;

      it("NEVER carries privileged:true", () => {
        expect(spec["privileged"]).toBeUndefined();
        expect(JSON.stringify(spec)).not.toContain('"privileged":true');
      });

      it("NEVER carries network:'host'", () => {
        expect(spec["network"]).not.toBe("host");
      });

      it("NEVER carries any capAdd", () => {
        const built = build(backend);
        expect(built.capAdd).toEqual([]);
        expect(built.capAdd.length).toBe(0);
      });

      it("env map is exactly empty (SBX-03 - no platform/key env)", () => {
        const built = build(backend);
        expect(built.env).toEqual({});
        expect(Object.keys(built.env)).toHaveLength(0);
      });
    });
  }
});

describe("runspec - misconfiguration guards", () => {
  it("rejects a non-positive timeout", () => {
    expect(() =>
      buildRunSpec({ backend: "gvisor", image: "r:1", limits: LIMITS, maxTimeoutSeconds: 0 }),
    ).toThrow(/maxTimeoutSeconds/);
  });

  it("rejects a non-positive memory limit", () => {
    expect(() =>
      buildRunSpec({
        backend: "gvisor",
        image: "r:1",
        limits: { ...LIMITS, memoryBytes: 0 },
        maxTimeoutSeconds: 30,
      }),
    ).toThrow(/memoryBytes/);
  });

  it("rejects a missing image", () => {
    expect(() =>
      buildRunSpec({ backend: "gvisor", image: "", limits: LIMITS, maxTimeoutSeconds: 30 }),
    ).toThrow(/image/);
  });
});
