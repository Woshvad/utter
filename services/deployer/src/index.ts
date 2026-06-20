// @utter/deployer — build the bundle -> run it in the sandbox -> generate Traefik
// wildcard-TLS dynamic config -> in-process x402 injection -> response cache ->
// health/reconcile loop (SPEC §9.3, §17; CONTEXT "services/deployer").
//
// This is the Wave 0 barrel: it starts as the in-memory store re-export and the
// feature waves (Plans 04-05) append the dockerode build, the in-process
// `requirePayment` x402 injection (reusing the Phase 2 gate), the per-resource
// Traefik dynamic-config generator, the Redis response cache + billable-disclosed
// cache-hit accounting (DEP-03), the deployment record + redeploy semantics
// (DEP-04), and the reconcile loop (DEP-05).

export {
  InMemoryDeploymentStore,
  InMemoryResponseCache,
  createInMemoryStores,
  type DeployerStores,
  type DeploymentRecord,
  type DeploymentStore,
  type ResponseCache,
} from "./stores/memory";

// In-process x402 injection (DEP-01): wrap a resource app in the Phase 2
// `requirePayment` escrow gate configured with this resource's pricing/escrow.
export {
  injectGate,
  buildResourceQuote,
  permissiveClassifier,
  type InjectGateConfig,
} from "./inject-x402";
