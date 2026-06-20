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
}

/**
 * Deployment records keyed on resourceId. All methods async so the Redis adapter
 * implements the identical contract. A redeploy bumps `deployVersion` while
 * keeping `agentId` + `slug` fixed (DEP-04).
 */
export interface DeploymentStore {
  /** Insert or update a deployment record (a redeploy bumps deployVersion). */
  put(record: DeploymentRecord): Promise<void>;
  /** Fetch a deployment record by resourceId, or null if absent. */
  get(resourceId: Hex): Promise<DeploymentRecord | null>;
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
}

/**
 * In-memory DeploymentStore (test default). Map-backed, keyed on resourceId.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly deployments = new Map<Hex, DeploymentRecord>();

  async put(record: DeploymentRecord): Promise<void> {
    this.deployments.set(record.resourceId, record);
  }

  async get(resourceId: Hex): Promise<DeploymentRecord | null> {
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
}

/** The store bundle the deployer routes. */
export interface DeployerStores {
  deployments: DeploymentStore;
  cache: ResponseCache;
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
