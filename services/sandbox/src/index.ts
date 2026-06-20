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
  type RunBackend,
  type RunOutcome,
  type RunRecord,
  type RunStore,
  type SandboxStores,
} from "./stores/memory";
