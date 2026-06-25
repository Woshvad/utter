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
  type DeploymentStatus,
  type DeploymentStore,
  type ResponseCache,
} from "./stores/memory";

// Health/reconcile loop (DEP-05): desired (records) vs actual (dockerode
// listContainers) drift + the tick/start/stop loop.
export {
  reconcile,
  createReconcileLoop,
  type ActualContainer,
  type ReconcileResult,
  type ReconcileLoop,
  type ReconcileLoopOpts,
} from "./reconcile";

// In-process x402 injection (DEP-01): wrap a resource app in the Phase 2
// `requirePayment` escrow gate configured with this resource's pricing/escrow.
export {
  injectGate,
  buildResourceQuote,
  permissiveClassifier,
  type InjectGateConfig,
} from "./inject-x402";

// Traefik dynamic-config generator (DEP-01 routing): per-resource file-provider
// config for Host(<slug>.resources.<domain>) with tls.certResolver=le + the
// wildcard SANs (DNS-01). The live cert + DNS are operator-provisioned (Plan 06).
export {
  buildTraefikDynamicConfig,
  serializeTraefikDynamicConfig,
  parseTraefikDynamicConfig,
  DEFAULT_RESOURCE_PORT,
  type TraefikDynamicConfig,
  type TraefikRouter,
  type TraefikService,
  type BuildTraefikDynamicConfigOpts,
} from "./traefik-config";

// Response cache (DEP-03): normalized + deployVersion-namespaced key; a HIT skips
// the handler, sets X-Cache: HIT, and STILL fires recordBillableCall (the disclosed
// billable call - never a free bypass; the lookup is AFTER /verify reserves).
export {
  cacheKey,
  getOrInvoke,
  recordBillableCall,
  createInMemoryBillingLog,
  type CachedRequest,
  type BillableCall,
  type RecordBillableCall,
  type GetOrInvokeOpts,
  type GetOrInvokeResult,
  type InMemoryBillingLog,
} from "./cache";

// Redeploy semantics (DEP-04): preserve agentId + slug/URL, bump deployVersion
// (price changes apply only to new calls), and invalidate the cache atomically by
// version-namespace bump (+ eager DEL of the old namespace).
export {
  redeploy,
  type RedeployOpts,
  type RedeployConfig,
} from "./redeploy";

// Hardened build (SBX-05): dockerode build from a pinned-by-digest base image +
// lockfile; registry swap via REGISTRY_MIRROR_URL; no-network-at-build is
// operator-gated (NOT claimed locally).
export {
  buildResourceImage,
  generateDockerfile,
  assertPinnedByDigest,
  resolveBaseImage,
  PINNED_BASE_IMAGES,
  type BuildResourceImageOpts,
  type BuildResult,
  type BuildSpec,
  type BundleRuntime,
  type NetworkIsolation,
} from "./build";

// Operator-gated live HTTPS deploy (DEP-01/02, PRX-02): deploy the echo bundle
// behind the real Traefik wildcard-TLS edge and curl 402-unpaid->200-paid over
// HTTPS + assert non-allowlisted unreachability. WRITTEN + type-checks, NEVER run
// in the autonomous suite (needs the provisioned host + *.resources.<domain> cert);
// recorded as a Deferred Item in STATE.md (Plan 06).
export { liveDeployEcho, type LiveDeployResult } from "./live-deploy";

// Echo bundler (deploy plane B): esbuild the echo into a single self-contained
// server.js + a prebundled Dockerfile (FROM the resolved digest, CMD node
// server.js) - the standalone artifact buildResourceImage streams to dockerode.
export {
  bundleEcho,
  buildEchoDockerfile,
  type BundleEchoOpts,
  type BundleEchoResult,
} from "./bundle-echo";
