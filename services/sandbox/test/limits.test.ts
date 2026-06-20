// limits.test.ts - the SBX-04 resource-limit flags are all present on the spec.
//
// Asserts the run-spec carries readonly root + a noexec,nosuid tmpfs + cap-drop
// ALL + pids + memory + cpu + timeout, and that `--storage-opt size=` is present
// but documented operator-gated (disk-quota enforcement needs overlay2 + xfs
// pquota; RESEARCH Pitfall 4). Pure - no container launch.
import { describe, expect, it } from "vitest";
import { buildRunSpec, type RunLimits } from "../src/runner/runspec";

const LIMITS: RunLimits = {
  pidsLimit: 128,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 0.5,
  storageOptSize: "512m",
};

const spec = buildRunSpec({
  backend: "gvisor",
  image: "resource:abc",
  limits: LIMITS,
  maxTimeoutSeconds: 30,
});

describe("limits - run-spec resource flags (SBX-04)", () => {
  it("carries a read-only root filesystem", () => {
    expect(spec.readonlyRootfs).toBe(true);
  });

  it("carries a tmpfs mounted noexec,nosuid", () => {
    const tmp = spec.tmpfs["/tmp"];
    expect(tmp).toBeDefined();
    expect(tmp).toContain("noexec");
    expect(tmp).toContain("nosuid");
  });

  it("forces noexec,nosuid even when the caller omits them", () => {
    const s = buildRunSpec({
      backend: "gvisor",
      image: "r:1",
      limits: LIMITS,
      maxTimeoutSeconds: 30,
      tmpfs: { "/tmp": "rw,size=8m" },
    });
    expect(s.tmpfs["/tmp"]).toContain("noexec");
    expect(s.tmpfs["/tmp"]).toContain("nosuid");
  });

  it("carries cap-drop ALL", () => {
    expect(spec.capDrop).toEqual(["ALL"]);
  });

  it("carries a positive pids limit", () => {
    expect(spec.pidsLimit).toBe(128);
    expect(spec.pidsLimit).toBeGreaterThan(0);
  });

  it("carries a positive memory limit", () => {
    expect(spec.memoryBytes).toBe(256 * 1024 * 1024);
    expect(spec.memoryBytes).toBeGreaterThan(0);
  });

  it("carries a positive cpu limit", () => {
    expect(spec.cpus).toBe(0.5);
    expect(spec.cpus).toBeGreaterThan(0);
  });

  it("carries the execution timeout (= maxTimeoutSeconds)", () => {
    expect(spec.timeoutSeconds).toBe(30);
  });

  it("carries --storage-opt size (operator-gated disk quota)", () => {
    expect(spec.storageOptSize).toBe("512m");
  });

  it("omits --storage-opt size when not requested (no false quota claim)", () => {
    const s = buildRunSpec({
      backend: "gvisor",
      image: "r:1",
      limits: { pidsLimit: 64, memoryBytes: 128 * 1024 * 1024, cpus: 0.25 },
      maxTimeoutSeconds: 30,
    });
    expect(s.storageOptSize).toBeUndefined();
  });
});
