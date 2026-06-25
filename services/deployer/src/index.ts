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
  type ReconcileErrorEvent,
} from "./reconcile";

// Global host concurrency cap (H4 / SPEC §9.5): the pure launch-admission helper
// the reconcile loop uses to defer (never silently drop) over-cap (re)launches.
export {
  admitLaunches,
  DEFAULT_MAX_CONCURRENT_RESOURCES,
  type AdmitLaunchesOpts,
  type AdmitLaunchesResult,
} from "./concurrency";

// Runaway-container classifier (H4 / SPEC §9.5): the pure verdict the loop uses to
// quarantine (record -> failed) + reap a wedged/CPU-pegged container.
export {
  classifyRunaway,
  DEFAULT_RUNAWAY_POLICY,
  type RunawayPolicy,
  type RunawayVerdict,
} from "./reaper";

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
  validateSlug,
  SLUG_PATTERN,
  DEFAULT_RESOURCE_PORT,
  type TraefikDynamicConfig,
  type TraefikRouter,
  type TraefikService,
  type BuildTraefikDynamicConfigOpts,
} from "./traefik-config";

// On-chain ResourceRegistry registration (design §5.2): inject an admin writer +
// reader, register the keccak resourceId idempotently before any debit can fire
// (else PaymentEscrow.debit reverts ResourceInactive). No key/env read here.
export {
  registerResourceIfNeeded,
  type RegistryAdminWriter,
  type RegistryReader,
  type RegisterResourceDeps,
  type RegisterResourceParams,
  type RegisterResourceResult,
} from "./register-resource";

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
export { liveDeployEcho, runEgressProbe, type LiveDeployResult, type DockerHandle } from "./live-deploy";

// Node-entry bundlers (deploy plane B): esbuild a workspace entrypoint into a single
// self-contained server.js + a prebundled Dockerfile (FROM the resolved digest, CMD
// node server.js) - the standalone artifact buildResourceImage streams to dockerode.
// bundleEcho is the Phase 1 in-process path; bundleEchoHandler (gate-less handler)
// and bundleSidecar (trusted gate-server) are the wave BC1 sidecar-topology images.
export {
  bundleEcho,
  bundleEchoHandler,
  bundleSidecar,
  buildEchoDockerfile,
  buildNodeBundleDockerfile,
  type BundleOpts,
  type BundleResult,
  type BundleEchoOpts,
  type BundleEchoResult,
} from "./bundle-echo";

// Deployer-side per-resource caller-auth token mint (C1): reuse the facilitator's
// mintResourceAuthToken to mint ONE rid-bound token per deploy for the SIDECAR
// (never the untrusted handler). Validates the secret (>=32 chars) and defaults to a
// non-expiring token; never reads process.env, never logs the secret/token.
export {
  mintFacilitatorToken,
  MIN_FACILITATOR_AUTH_SECRET_LENGTH,
  type MintFacilitatorTokenOpts,
} from "./facilitator-token";

// Deploy orchestrator (host phase H2): build the echo image, run it as a hardened
// runsc service on utter_appnet, atomically write the Traefik route, and resolve a
// real dockerode handle on the provisioned host. launchEchoContainer /
// reapEchoContainer are the real launch/reap the future reconcile hooks (H3) reuse.
export {
  resolveDockerHandle,
  resolveFacilitatorUrl,
  buildEchoServiceEnv,
  writeTraefikDynamicFile,
  removeTraefikDynamicFile,
  launchEchoContainer,
  reapEchoContainer,
  listResourceContainers,
  reapResourceContainer,
  waitForUnpaid402,
  ECHO_SERVICE,
  ECHO_IMAGE_TAG,
  RESOURCE_ID_LABEL,
  SLUG_LABEL,
  type ResolveFacilitatorUrlOpts,
  type BuildEchoServiceEnvOpts,
  type WriteTraefikDynamicFileOpts,
  type LaunchEchoContainerOpts,
  type LaunchEchoContainerResult,
  type WaitForUnpaid402Opts,
} from "./orchestrate";

// Sidecar topology (Security review C1, wave BC2b): the two-container PAIR launch +
// reap. launchResourcePair builds + runs a gate-less untrusted HANDLER (no facilitator
// route/token) then a trusted SIDECAR gate (holding the token + classifier schema),
// reaching the handler by its inspected IP; Traefik routes to the sidecar
// (sidecarContainerUrl). reapResourcePair tears down both + the route. The handler env
// (buildHandlerServiceEnv) carries NO facilitator/token; the sidecar env
// (buildSidecarServiceEnv) carries them via the trusted spec.
export {
  launchResourcePair,
  reapResourcePair,
  reapOrphanPairNetworks,
  pairnetName,
  PAIRNET_KIND_LABEL,
  PAIRNET_KIND,
  pairNames,
  sidecarContainerUrl,
  buildHandlerServiceEnv,
  buildSidecarServiceEnv,
  PAIR_NETWORKS,
  PAIR_PORT,
  ROLE_LABEL,
  ROLE_HANDLER,
  ROLE_GATE,
  type LaunchResourcePairOpts,
  type LaunchResourcePairResult,
  type BuildHandlerServiceEnvOpts,
  type BuildSidecarServiceEnvOpts,
} from "./orchestrate";
