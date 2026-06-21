// @utter/orchestrator - the SCL-01 control plane: cross-host scheduling,
// scale-to-zero, warm pool, idle reaper (SPEC §12; CONTEXT "services/orchestrator").
//
// This is the Wave 0 barrel stub. The SCL-01 feature wave replaces it with the
// Orchestrator interface, the in-process LocalDriver default, the operator-gated
// NomadDriver stub (throws RequiresLiveOrchestrator until provisioned), the
// warm pool, the idle-TTL reaper (injected clock), and the deterministic
// least-loaded placement function.
//
// SCHEDULING-ONLY NOTE: the orchestrator SCHEDULES the Phase 3 hardened
// SandboxRunner.run(spec); it NEVER re-implements isolation or builds its own
// launch spec. The only trusted isolation boundary is the gvisor backend on the
// operator-provisioned host (CLAUDE.md, SPEC §9.5); the live multi-host Nomad
// half is operator-gated.

export {};
