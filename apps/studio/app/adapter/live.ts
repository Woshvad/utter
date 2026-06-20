// live.ts - the operator-gated, fail-loud LiveAdapter.
//
// LiveAdapter is NEVER available autonomously: every sub-call that needs a
// provisioned host / funded wallet / live services throws RequiresLiveServicesError
// so the autonomous suite can never silently exercise a live path (mirrors
// prober.ts LiveHttpsProber + RequiresProvisionedHostError, and test-endpoint.ts
// liveTestEndpoint + RequiresFundedWalletError). Later plans wire the read-through
// where a host already exists; the bodies here are fail-loud stubs.
import type {
  BuildEvent,
  ComposeSpec,
  Hex,
  PlaygroundResult,
  ResourceCardData,
  ResourceDetail,
  RevenueSummary,
  StudioDataAdapter,
  UsdcBalance,
} from "./types.js";
import type { FilterCriteria } from "@utter/marketplace";

/**
 * The error thrown when the live adapter is invoked without the operator-
 * provisioned services (wildcard-TLS host, funded relayer wallet, live registry).
 * The live Studio path inherits the Phase 3/5 host + funded-wallet prerequisites
 * (Deferred Items); it is NOT autonomous (mirrors RequiresProvisionedHostError).
 */
export class RequiresLiveServicesError extends Error {
  readonly code = "requiresLiveServices" as const;
  constructor() {
    super(
      "LiveAdapter requires operator-provisioned live services (the wildcard-TLS " +
        "resources host, a funded relayer wallet, and the live registry reads). The " +
        "live Studio data path is operator-gated; it is NOT autonomous.",
    );
    this.name = "RequiresLiveServicesError";
  }
}

/**
 * The operator-gated live adapter stub. Every method throws
 * RequiresLiveServicesError until wired against the provisioned services in a later
 * operator-gated plan, so the autonomous suite cannot mistake it for a live read.
 */
export class LiveAdapter implements StudioDataAdapter {
  readonly backend = "live" as const;

  async createResource(_spec: ComposeSpec): Promise<{ resourceId: string; eventsUrl: string }> {
    throw new RequiresLiveServicesError();
  }

  async *subscribeBuildEvents(_resourceId: string): AsyncIterable<BuildEvent> {
    throw new RequiresLiveServicesError();
  }

  async getResourceDetail(_resourceId: string): Promise<ResourceDetail> {
    throw new RequiresLiveServicesError();
  }

  async listMarketplace(_criteria: FilterCriteria): Promise<ResourceCardData[]> {
    throw new RequiresLiveServicesError();
  }

  async getRevenue(_resourceId: string): Promise<RevenueSummary> {
    throw new RequiresLiveServicesError();
  }

  async getEscrowBalance(_address: Hex): Promise<UsdcBalance> {
    throw new RequiresLiveServicesError();
  }

  async runPlayground(_resourceId: string, _req: unknown): Promise<PlaygroundResult> {
    throw new RequiresLiveServicesError();
  }
}
