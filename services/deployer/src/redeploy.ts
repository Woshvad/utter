// redeploy.ts - redeploy semantics (DEP-04).
//
// A redeploy is an IDENTITY-PRESERVING version bump. The resource keeps its on-chain
// identity (`agentId`) and its public address (`slug` -> `<slug>.resources.<domain>`)
// across the redeploy - a buyer's bookmarked URL + the ERC-8004 binding never change.
// What DOES change:
//   - `deployVersion` bumps n -> n+1. Because the response cache keys are namespaced
//     `resource:<id>:v<deployVersion>:<hash>` (DEP-03), the bump makes EVERY old-version
//     key unreachable in one step = ATOMIC cache invalidation (T-03-21). We also issue
//     an eager `delByPrefix` so stale bytes do not linger until TTL-expiry.
//   - a price change in `config` applies ONLY to NEW calls: the new version's record
//     carries the new pricing, and any previously-cached old-version result is simply
//     unreachable - never retro-repriced (T-03-22).
import type { Hex } from "viem";
import type { DeploymentRecord, DeploymentStore, ResponseCache } from "./stores/memory";

/** The mutable, version-scoped config a redeploy can change (NOT identity). */
export interface RedeployConfig {
  /** The new signed spend cap (USDC base units). Applies only to new calls. */
  cap?: bigint;
  /** The desired lifecycle status of the new version (default: keep the prior status). */
  status?: DeploymentRecord["status"];
}

/** Options for {@link redeploy}. */
export interface RedeployOpts {
  /** The deployment-record store (the source of the preserved identity). */
  store: DeploymentStore;
  /** The resource being redeployed. */
  resourceId: Hex;
  /** The version-scoped config changes (pricing/status). Identity is never taken here. */
  config?: RedeployConfig;
  /**
   * The response cache to eagerly invalidate. Optional: the deployVersion bump alone
   * makes old keys unreachable; passing the cache also eagerly DELs the old namespace.
   */
  cache?: ResponseCache;
  /** Clock injection for `updatedAt` (tests pin it). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Redeploy a resource (DEP-04): PRESERVE `agentId` + `slug`/URL, BUMP `deployVersion`,
 * apply the new pricing/config to the NEW version only, persist the new record, and
 * invalidate the cache by version-namespace bump (+ an eager DEL of the old namespace).
 * Returns the new record. Throws if the resource was never deployed (nothing to
 * redeploy - a redeploy is an UPDATE, not a first deploy).
 */
export async function redeploy(opts: RedeployOpts): Promise<DeploymentRecord> {
  const existing = await opts.store.get(opts.resourceId);
  if (!existing) {
    throw new Error(
      `redeploy: no existing deployment for resource ${opts.resourceId} (nothing to redeploy)`,
    );
  }

  const now = opts.now ?? Date.now;
  const oldVersion = existing.deployVersion;
  const newVersion = oldVersion + 1;

  const next: DeploymentRecord = {
    // PRESERVED identity (never re-derived from config).
    agentId: existing.agentId,
    resourceId: existing.resourceId,
    slug: existing.slug,
    // BUMPED version -> the cache namespace changes (atomic invalidation).
    deployVersion: newVersion,
    // Version-scoped config: new pricing applies ONLY to this (new) version.
    cap: opts.config?.cap ?? existing.cap,
    status: opts.config?.status ?? existing.status,
    updatedAt: now(),
  };

  await opts.store.put(next);

  // Eager cache invalidation of the OLD version's namespace (the bump already made
  // those keys unreachable; this removes the bytes so nothing serves stale at the
  // old version even by direct key access).
  if (opts.cache) {
    await opts.cache.delByPrefix(`resource:${opts.resourceId}:v${oldVersion}:`);
  }

  return next;
}
