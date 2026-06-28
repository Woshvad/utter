// record-deploy.ts - persist a durable DeploymentRecord on a successful deploy.
//
// POST /deploy runs deploy(req, onProgress) and brings a generated bundle live, but
// nothing has been writing the desired-state record the reconcile loop converges on.
// recordDeployment closes that gap: after a deploy resolves, it writes (or version-bumps)
// the resource's DeploymentRecord so GET /deployments returns it and the reconcile loop
// (subtask 7) has a desired state to drive actual containers toward.
//
// A repeat deploy of the SAME resourceId is an idempotent redeploy: it delegates to the
// existing redeploy() helper so deployVersion bumps n -> n+1 while agentId + slug are
// preserved (DEP-04). A first deploy writes a fresh v1 record through store.put, which
// enforces M5 slug-uniqueness (SlugConflictError on a cross-resourceId slug clash).
import type { Hex } from "viem";
import type { DeploymentRecord, DeploymentStore } from "./stores/memory";
import { redeploy } from "./redeploy";

/** Inputs for {@link recordDeployment}. The resourceId is the stable, redeploy-invariant id. */
export interface RecordDeployParams {
  /** The on-chain resource id (bytes32 Hex) this deploy is bound to. */
  resourceId: Hex;
  /** The URL slug (`<slug>.resources.<domain>`). */
  slug: string;
  /** The optional signed spend cap for this version (USDC base units). */
  cap?: bigint;
  /** Clock injection for `updatedAt` (tests pin it). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Record a successful deploy's desired-state DeploymentRecord.
 *
 * If a record already exists for this resourceId this is an idempotent REDEPLOY: it
 * delegates to redeploy(), which bumps deployVersion and preserves agentId + slug
 * (DEP-04). Otherwise it builds a fresh v1 record and writes it through store.put,
 * which enforces M5 slug-uniqueness (throwing SlugConflictError if the slug is already
 * held by a different resourceId). Returns the stored record.
 */
export async function recordDeployment(
  store: DeploymentStore,
  params: RecordDeployParams,
): Promise<DeploymentRecord> {
  const existing = await store.get(params.resourceId);
  if (existing) {
    return redeploy({
      store,
      resourceId: params.resourceId,
      config: { cap: params.cap ?? existing.cap, status: "running" },
      now: params.now,
    });
  }

  // The ERC-8004 agentId mint is DEFERRED per the testnet policy, so the placeholder
  // agentId is the resourceId itself: a stable, unique, redeploy-invariant id this
  // resource is already bound to. When the real mint lands this field will carry the
  // minted agentId; no fake numeric agentId is fabricated here.
  const record: DeploymentRecord = {
    agentId: params.resourceId,
    resourceId: params.resourceId,
    slug: params.slug,
    deployVersion: 1,
    status: "running",
    updatedAt: (params.now ?? Date.now)(),
    ...(params.cap !== undefined ? { cap: params.cap } : {}),
  };
  await store.put(record);
  return record;
}
