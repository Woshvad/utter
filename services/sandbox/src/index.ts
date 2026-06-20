// @utter/sandbox — the untrusted-code isolation runner + egress firewall +
// pre-publish scans (SPEC §9.5, §17; CONTEXT "services/sandbox").
//
// This is the Wave 0 barrel: it starts as the in-memory store re-export and the
// feature waves (Plan 02) append the runner interface (gvisor | docker-dev
// backends), the hardened run-spec builder, the egress-firewall ruleset
// generator, the HARD request/response size cap, and the static pre-publish
// scans (secret scan + dangerous-import deny-list).
//
// SECURITY BOUNDARY NOTE: the only trusted isolation backend is `gvisor` (runsc)
// on the operator-provisioned host. The `docker-dev` backend (plain Docker /
// Docker Desktop) is wiring + integration-test scaffolding ONLY and is NEVER a
// security boundary (CLAUDE.md, SPEC §9.5). The live security acceptance
// (malicious-probe-blocked, SBX-02/06) is operator-gated.

export {
  InMemoryRunStore,
  createInMemoryStores,
  type RunOutcome,
  type RunRecord,
  type RunStore,
  type SandboxStores,
} from "./stores/memory";

// --- Runner: the pluggable SandboxRunner + the hardened run-spec builder (Plan 02 Task 1) ---
export type {
  ContainerRuntime,
  RunBackend,
  RunHandle,
  RunInspect,
  RunLogs,
  RunSpec,
  SandboxRunner,
} from "./runner/types";
export {
  buildRunSpec,
  type BuildRunSpecOptions,
  type RunLimits,
} from "./runner/runspec";
export { DockerDevRunner } from "./runner/docker-dev";
export { GvisorRunner } from "./runner/gvisor";

// --- Egress firewall: default-deny ruleset generator, only-proxy (Plan 02 Task 2) ---
export {
  EGRESS_BLOCK_SET,
  buildEgressRuleset,
  type BuildEgressRulesetOptions,
  type EgressBlockEntry,
  type EgressMechanism,
  type EgressRuleset,
} from "./egress/firewall";

// --- Pre-publish static scans + operator-gated dynamic probe (Plan 02 Task 3) ---
export {
  DISALLOWED_IMPORTS,
  scanImports,
  type ImportViolation,
} from "./prepublish/import-scan";
export {
  scanSecrets,
  shannonEntropy,
  type Bundle,
  type SecretViolation,
} from "./prepublish/secret-scan";
export {
  runPrePublishStaticChecks,
  type PrePublishResult,
  type PrePublishViolation,
} from "./prepublish/checks";
export {
  DEFAULT_PROBE_TARGETS,
  RequiresProvisionedHostError,
  createOperatorGatedProbe,
  type DynamicHostProbe,
  type ProbeTarget,
} from "./prepublish/probe";
