// @utter/orchestrator - the SCL-01 control plane: cross-host scheduling,
// scale-to-zero, warm pool, idle reaper (SPEC §12; CONTEXT "services/orchestrator").
//
// SCHEDULING-ONLY NOTE: the orchestrator SCHEDULES the Phase 3 hardened
// SandboxRunner.run(spec); it NEVER re-implements isolation or builds its own
// launch spec. The only trusted isolation boundary is the gvisor backend on the
// operator-provisioned host (CLAUDE.md, SPEC §9.5); the live multi-host Nomad
// half is operator-gated (NomadDriver throws RequiresLiveOrchestrator until
// provisioned). The in-process LocalDriver is the deterministic autonomous default.

// The pluggable control-plane interface (schedules RunSpec via SandboxRunner.run).
export type { Orchestrator } from "./orchestrator.js";

// The in-process deterministic default + the operator-gated live stub + factory.
export { LocalDriver } from "./local-driver.js";
export type { LocalDriverDeps } from "./local-driver.js";
export { NomadDriver, RequiresLiveOrchestrator } from "./nomad-driver.js";
export { selectOrchestrator } from "./select-driver.js";
export type { SelectOrchestratorDeps } from "./select-driver.js";

// Scale-to-zero building blocks: warm pool (cold-start bound) + idle reaper.
export { WarmPool, DEFAULT_WARM_POOL_SIZE } from "./warm-pool.js";
export type { WarmPoolOptions } from "./warm-pool.js";
export { IdleReaper } from "./reaper.js";
export type { IdleReaperOptions } from "./reaper.js";

// Pure deterministic least-loaded bin-packing placement.
export { place } from "./placement.js";
export type { Host, PlacementResult } from "./placement.js";
