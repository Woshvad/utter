// warm-pool.ts - the pre-warmed sandbox pool (bounds cold-start).
//
// Mirrors the InMemoryQuotaStore shape (packages/data-proxy/src/quota.ts:40-52):
// a Map-backed in-memory registry that the real (Redis/host-pool) adapter drops
// in behind later. A WarmPool holds already-launched sandboxes per resource so
// the first call after idle resolves a sandbox WITHOUT a cold launch, keeping
// cold-start under the handler timeout budget (T-08-COLDSTART; RESEARCH Pitfall
// 8). The pool size is an env-configured default that MUST be > 0 - a size of 0
// would defeat the whole purpose (every call would cold-start).
import type { RunHandle } from "@utter/sandbox";

/** The default warm-pool size when none is configured. Always > 0. */
export const DEFAULT_WARM_POOL_SIZE = 2;

/** What constructs a WarmPool. `size` must be > 0 (guarded in the constructor). */
export interface WarmPoolOptions {
  /** How many pre-warmed sandboxes to keep per resource. Must be > 0. */
  size?: number;
}

/**
 * A pre-warmed sandbox pool. `release` returns a launched sandbox to the pool
 * (up to `size` per resource); `acquire` hands one back (cold-start avoided) or
 * `undefined` when the pool is empty for that resource (the caller then cold-
 * launches via SandboxRunner.run). Map-backed in-memory default - no clock, no
 * random, deterministic.
 */
export class WarmPool {
  /** The configured pool size (sandboxes kept warm per resource). Always > 0. */
  readonly size: number;
  /** Per-resource warm sandbox handles (LIFO is fine; placement is elsewhere). */
  private readonly pool = new Map<string, RunHandle[]>();

  constructor(opts: WarmPoolOptions = {}) {
    const size = opts.size ?? DEFAULT_WARM_POOL_SIZE;
    if (size <= 0) {
      throw new Error(
        `WarmPool: size must be > 0 (got ${size}); a zero pool would cold-start ` +
          "every call past the timeout budget.",
      );
    }
    this.size = size;
  }

  /**
   * Take a pre-warmed sandbox for `resourceId` (cold-start avoided), or
   * `undefined` when none is warm. Deterministic - pops the most-recently
   * released handle.
   */
  acquire(resourceId: string): RunHandle | undefined {
    const warm = this.pool.get(resourceId);
    if (!warm || warm.length === 0) return undefined;
    return warm.pop();
  }

  /**
   * Return a launched sandbox to the pool for reuse, up to `size` per resource.
   * Excess handles are dropped (the caller stops them) so the pool never grows
   * past its configured ceiling.
   */
  release(resourceId: string, handle: RunHandle): boolean {
    const warm = this.pool.get(resourceId) ?? [];
    if (warm.length >= this.size) return false;
    warm.push(handle);
    this.pool.set(resourceId, warm);
    return true;
  }

  /** How many sandboxes are currently warm for `resourceId` (test introspection). */
  warmCount(resourceId: string): number {
    return this.pool.get(resourceId)?.length ?? 0;
  }

  /**
   * Remove and return ALL warm sandboxes for `resourceId` (the pool is emptied for
   * that resource). The caller stops each through the SandboxRunner - this is how the
   * idle reaper drains the warm pool so an idle resource truly scales to zero (WR-01)
   * instead of leaving pre-warmed sandboxes running past the idle TTL.
   */
  drain(resourceId: string): RunHandle[] {
    const warm = this.pool.get(resourceId) ?? [];
    this.pool.delete(resourceId);
    return warm;
  }
}
