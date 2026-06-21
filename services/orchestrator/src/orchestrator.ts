// orchestrator.ts - the SCL-01 control-plane interface.
//
// Mirrors the SandboxRunner pluggable interface (services/sandbox/src/runner/
// types.ts:136-147): a readonly `driver` discriminant + lifecycle methods. The
// Orchestrator SCHEDULES the Phase 3 hardened RunSpec through SandboxRunner.run
// - it imports RunSpec/RunHandle/SandboxRunner from @utter/sandbox and NEVER
// re-declares a hardening field of its own. The only trusted isolation boundary
// is the gvisor backend on the operator host (CLAUDE.md, SPEC §9.5); the
// orchestrator is a scheduler, not an isolation boundary (T-08-UNHARDENED).
import type { RunSpec, RunHandle } from "@utter/sandbox";

/**
 * The pluggable orchestration control plane. Two drivers implement it: the
 * in-process `LocalDriver` (the deterministic test/CI default) and the
 * operator-gated `NomadDriver` (fail-loud until provisioned). The interface is
 * identical so the autonomous suite exercises the same contract with no live
 * Nomad host (mirrors the SandboxRunner two-backend pattern).
 */
export interface Orchestrator {
  /** Which driver this is. `nomad` is operator-gated (RequiresLiveOrchestrator). */
  readonly driver: "local" | "nomad";
  /**
   * Schedule a resource's handler: place it on a host and launch (or reuse a
   * warm) sandbox from the Phase 3 hardened `spec`. The spec is passed THROUGH
   * untouched to `SandboxRunner.run` - the orchestrator never re-builds it.
   */
  schedule(resourceId: string, spec: RunSpec): Promise<RunHandle>;
  /**
   * Reap idle sandboxes whose idle age exceeds the TTL as of `now` (injected
   * clock; no Date.now() in the window math). A resource with no traffic reaps
   * to zero and consumes no compute.
   */
  reap(now: number): Promise<void>;
}
