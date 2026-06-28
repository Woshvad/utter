// Deployer in-memory deployment store + response cache (test default; DEP-03/04).
//
// Mirrors the Phase 2 pluggable-adapter pattern (services/facilitator/src/
// stores/memory.ts): `createInMemoryStores()` returns the SAME interfaces the
// future Redis-backed adapter (Wave 2+) implements, so the autonomous deploy
// suite runs with NO Redis. The in-memory adapter is the TEST DEFAULT; the prod
// adapter is a drop-in swap by env at deployer bootstrap.
//
// Two stores live here:
//   - DeploymentStore: the agentId/slug/version records that drive redeploy
//     semantics (DEP-04 — agentId + slug persist across redeploys; the cache is
//     namespaced by deployVersion so a bump atomically invalidates old keys).
//   - ResponseCache: the normalized-request -> body cache (DEP-03). A HIT skips
//     the handler but the billing hook still fires upstream (the cache NEVER
//     bypasses the money path — that wiring lands in Plan 04/05).
import type { Hex } from "viem";

/** The lifecycle status of a deployment record (the reconcile loop's desired state). */
export type DeploymentStatus = "running" | "stopped" | "deploying" | "failed";

/** A deployed resource's identity + current version (redeploy semantics, DEP-04). */
export interface DeploymentRecord {
  /** The ERC-8004 agent id this resource is bound to (stable across redeploys). */
  agentId: Hex;
  /** The resource id (bytes32 Hex). */
  resourceId: Hex;
  /** The URL slug `<slug>.resources.<domain>` (stable across redeploys). */
  slug: string;
  /** Monotonic deploy version; a bump namespaces the cache for atomic invalidation. */
  deployVersion: number;
  /** The desired lifecycle status (the reconcile loop drives actual toward this). */
  status: DeploymentStatus;
  /** Epoch ms of the most recent (re)deploy. */
  updatedAt: number;
  /**
   * The signed spend cap for THIS version (USDC base units). Optional: pricing-bearing
   * fields are version-scoped so a redeploy (DEP-04) applies a price change ONLY to
   * new calls (the new version's quote), never retro-repricing old/cached results.
   */
  cap?: bigint;
}

/**
 * Thrown by put() when a slug is already claimed by a DIFFERENT resourceId (M5).
 *
 * This is the fail-loud upstream slug-allocation guard. Two resourceIds sharing one
 * slug derive the SAME utter_pairnet_<slug> internal bridge and co-tenant a single
 * network, re-opening the cross-tenant free-compute HIGH (infrastructure/
 * RESOURCE-DEPLOY-SECURITY-REVIEW.md:81-89). The network-layer ensurePairNetwork
 * resourceId-label guard is only a backstop; the store is the upstream allocator that
 * must reject a duplicate slug before any pairnet/Traefik file write. The message names
 * the slug AND both resourceIds so an operator sees exactly which deploy double-allocated.
 */
export class SlugConflictError extends Error {
  readonly slug: string;
  readonly existingResourceId: Hex;
  readonly incomingResourceId: Hex;

  constructor(slug: string, existingResourceId: Hex, incomingResourceId: Hex) {
    super(
      `slug "${slug}" is already claimed by resourceId ${existingResourceId}; ` +
        `resourceId ${incomingResourceId} cannot reuse it`,
    );
    this.name = "SlugConflictError";
    this.slug = slug;
    this.existingResourceId = existingResourceId;
    this.incomingResourceId = incomingResourceId;
  }
}

/**
 * Deployment records keyed on resourceId. All methods async so the Redis adapter
 * implements the identical contract. A redeploy bumps `deployVersion` while
 * keeping `agentId` + `slug` fixed (DEP-04).
 *
 * Slug uniqueness (M5): put() enforces a global slug -> resourceId mapping. A slug
 * may belong to exactly ONE resourceId at a time; a put() of an already-held slug by a
 * different resourceId throws SlugConflictError. A same-resourceId redeploy (same slug,
 * bumped deployVersion) is idempotent and never throws. The Redis-backed adapter MUST
 * perform the identical atomic claim via a reverse key (for example SETNX slug:<slug> ->
 * resourceId, or a WATCH/Lua transaction) with the SAME throw-on-mismatch and
 * idempotent-same-owner semantics, so a Redis adapter cannot silently diverge from the
 * in-memory one.
 */
export interface DeploymentStore {
  /**
   * Insert or update a deployment record (a redeploy bumps deployVersion). Throws
   * SlugConflictError if record.slug is already held by a different resourceId (M5).
   */
  put(record: DeploymentRecord): Promise<void>;
  /** Fetch a deployment record by resourceId, or null if absent. */
  get(resourceId: Hex): Promise<DeploymentRecord | null>;
  /** Fetch the deployment record owning a slug, or null if the slug is unclaimed. */
  getBySlug(slug: string): Promise<DeploymentRecord | null>;
  /** List all current deployment records (the reconcile loop's desired state). */
  list(): Promise<DeploymentRecord[]>;
}

/**
 * The response cache (DEP-03). Keys are the normalized-request hash, namespaced by
 * deployVersion so a redeploy atomically invalidates. A HIT returns the cached
 * body; the billing hook fires upstream (the cache is NOT a money-path bypass).
 */
export interface ResponseCache {
  /** Fetch a cached body by key, or null on miss / TTL-expiry. */
  get(key: string): Promise<string | null>;
  /** Store a body under key with a TTL in seconds. */
  set(key: string, body: string, ttlSeconds: number): Promise<void>;
  /**
   * Delete every key under a resource:version prefix (eager invalidation on redeploy,
   * DEP-04). The deployVersion bump ALONE makes old keys unreachable; this is the
   * optional eager cleanup so stale bytes do not linger to TTL-expiry. In prod the
   * ioredis adapter implements this via a SCAN+DEL over `resource:<id>:v<old>:*`.
   */
  delByPrefix(prefix: string): Promise<void>;
}

/**
 * In-memory DeploymentStore (test default). Map-backed, keyed on resourceId.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly deployments = new Map<Hex, DeploymentRecord>();
  /** Reverse index slug -> owning resourceId; the source of slug-uniqueness truth (M5). */
  private readonly slugToResourceId = new Map<string, Hex>();

  async put(record: DeploymentRecord): Promise<void> {
    // The check and the claim run in ONE synchronous tick with no await between the
    // read and the write, which is what makes the in-memory slug claim atomic: no
    // other put() can interleave, so two concurrent puts cannot both pass the check.
    const existingOwner = this.slugToResourceId.get(record.slug);
    if (existingOwner !== undefined && existingOwner !== record.resourceId) {
      // Throw BEFORE mutating either Map so the conflict path leaves the original
      // owner's record byte-for-byte unchanged and still resolvable.
      throw new SlugConflictError(record.slug, existingOwner, record.resourceId);
    }

    // If this resourceId already held a DIFFERENT slug (an own-slug change), free the
    // stale reverse-index entry so the freed slug is not falsely reserved.
    const previous = this.deployments.get(record.resourceId);
    if (previous && previous.slug !== record.slug) {
      this.slugToResourceId.delete(previous.slug);
    }

    // Claim the slug and store the record. A same-resourceId same-slug redeploy is a
    // no-op on the reverse index and never throws (DEP-04 idempotence).
    this.slugToResourceId.set(record.slug, record.resourceId);
    this.deployments.set(record.resourceId, record);
  }

  async get(resourceId: Hex): Promise<DeploymentRecord | null> {
    return this.deployments.get(resourceId) ?? null;
  }

  async getBySlug(slug: string): Promise<DeploymentRecord | null> {
    const resourceId = this.slugToResourceId.get(slug);
    if (resourceId === undefined) return null;
    return this.deployments.get(resourceId) ?? null;
  }

  async list(): Promise<DeploymentRecord[]> {
    return [...this.deployments.values()];
  }
}

/**
 * In-memory ResponseCache (test default). Map-backed; entries expire by their TTL
 * lazily on read so an expired key returns null without a sweeper.
 */
export class InMemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, { body: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.body;
  }

  async set(key: string, body: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { body, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

/** The store bundle the deployer routes. */
export interface DeployerStores {
  deployments: DeploymentStore;
  cache: ResponseCache;
  /**
   * Teardown for the durable adapter (redis.quit), called from graceful shutdown AFTER
   * the request drain. Undefined for the in-memory default (nothing to close), so
   * dev/test boot is byte-unchanged.
   */
  close?: () => Promise<void>;
}

/**
 * Build the in-memory deployer stores (test default — no Redis). The future Redis
 * adapter exposes the same `DeployerStores` shape so the deployer can swap
 * adapters by env without touching deploy/cache logic.
 */
export function createInMemoryStores(): DeployerStores {
  return {
    deployments: new InMemoryDeploymentStore(),
    cache: new InMemoryResponseCache(),
  };
}
