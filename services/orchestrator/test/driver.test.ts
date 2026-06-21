// Driver-seam tests for @utter/orchestrator (SCL-01 Task 1).
//
// Asserts the pluggable Orchestrator seam: selectOrchestrator defaults to the
// deterministic in-process LocalDriver, ORCHESTRATOR=nomad returns the
// operator-gated NomadDriver (throws RequiresLiveOrchestrator), and the
// LocalDriver SCHEDULES the Phase 3 hardened RunSpec through the injected
// SandboxRunner.run WITHOUT mutating/re-building it (T-08-UNHARDENED). No
// network, chain, or isolation host is touched.
import { describe, it, expect, vi } from "vitest";
import type {
  RunSpec,
  RunHandle,
  SandboxRunner,
  RunLogs,
  RunInspect,
} from "@utter/sandbox";
import {
  selectOrchestrator,
  LocalDriver,
  NomadDriver,
  RequiresLiveOrchestrator,
} from "../src/index";

/** A fully-resolved hardened spec fixture (mirrors the Phase 3 RunSpec invariants). */
function makeSpec(): RunSpec {
  return {
    image: "utter/resource:abc@v1",
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
    timeoutSeconds: 30,
    env: {},
  };
}

/** A spy SandboxRunner: records the exact spec object run() receives. */
function makeSpyRunner(): {
  runner: SandboxRunner;
  run: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(
    async (spec: RunSpec): Promise<RunHandle> => ({
      id: `run-${spec.image}`,
      backend: "docker-dev",
      wait: async () => 0,
    }),
  );
  const stop = vi.fn(async (_id: string): Promise<void> => undefined);
  const runner: SandboxRunner = {
    backend: "docker-dev",
    run,
    stop,
    logs: async (): Promise<RunLogs> => ({ stdout: "", stderr: "" }),
    inspect: async (id: string): Promise<RunInspect> => ({
      id,
      running: true,
      exitCode: null,
    }),
  };
  return { runner, run, stop };
}

describe("selectOrchestrator (env-gated driver factory)", () => {
  it("returns a LocalDriver (driver === 'local') with no ORCHESTRATOR env", () => {
    const { runner } = makeSpyRunner();
    const orch = selectOrchestrator({}, { runner });
    expect(orch).toBeInstanceOf(LocalDriver);
    expect(orch.driver).toBe("local");
  });

  it("returns a NomadDriver (driver === 'nomad') when ORCHESTRATOR=nomad", () => {
    const orch = selectOrchestrator({ ORCHESTRATOR: "nomad" });
    expect(orch).toBeInstanceOf(NomadDriver);
    expect(orch.driver).toBe("nomad");
  });

  it("ignores ORCHESTRATOR values other than 'nomad' (absent-env-to-local)", () => {
    const { runner } = makeSpyRunner();
    const orch = selectOrchestrator({ ORCHESTRATOR: "anything-else" }, { runner });
    expect(orch.driver).toBe("local");
  });
});

describe("NomadDriver (operator-gated, fail-loud)", () => {
  it("schedule() throws RequiresLiveOrchestrator with the code discriminant", async () => {
    const orch = new NomadDriver();
    await expect(orch.schedule("res-1", makeSpec())).rejects.toBeInstanceOf(
      RequiresLiveOrchestrator,
    );
    await orch.schedule("res-1", makeSpec()).catch((err) => {
      expect((err as RequiresLiveOrchestrator).code).toBe(
        "requiresLiveOrchestrator",
      );
    });
  });

  it("reap() also throws RequiresLiveOrchestrator", async () => {
    const orch = new NomadDriver();
    await expect(orch.reap(0)).rejects.toBeInstanceOf(RequiresLiveOrchestrator);
  });
});

describe("LocalDriver schedules the Phase 3 RunSpec verbatim (T-08-UNHARDENED)", () => {
  it("calls the injected SandboxRunner.run with the SAME spec object", async () => {
    const { runner, run } = makeSpyRunner();
    const orch = new LocalDriver({ runner });
    const spec = makeSpec();
    const handle = await orch.schedule("res-1", spec);

    // The REQUEST-path launch is the first run() call, with the spec passed THROUGH
    // untouched (no re-build). The handle is served from that launch.
    expect(run.mock.calls[0]?.[0]).toBe(spec);
    expect(handle.id).toBe("run-utter/resource:abc@v1");
    // The off-hot-path warm-pool top-up also passes the SAME spec object through
    // verbatim (WR-01): every run() call - request AND replenish - receives `spec`.
    await orch.warmupSettled("res-1");
    for (const call of run.mock.calls) {
      expect(call[0]).toBe(spec);
    }
  });

  it("does not mutate any RunSpec hardening field", async () => {
    const { runner } = makeSpyRunner();
    const orch = new LocalDriver({ runner });
    const spec = makeSpec();
    const snapshot = JSON.stringify(spec);
    await orch.schedule("res-1", spec);
    await orch.warmupSettled("res-1"); // include the replenish launches in the check
    expect(JSON.stringify(spec)).toBe(snapshot);
  });
});
