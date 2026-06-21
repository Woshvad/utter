// reaper.ts - the idle-TTL reaper (scale-to-zero on an injected clock).
//
// Mirrors the injected-clock discipline (RESEARCH Pattern 2; the ai-scorer
// fake-clock precedent): every time decision takes `now: number` as a parameter
// - there is NO Date.now() in the window math, so the TTL comparison is fully
// deterministic and assertable with a fake clock. A resource with no traffic has
// its sandbox stopped once its idle age exceeds the TTL, so it consumes no
// compute (scale-to-zero; T-08-COLDSTART's complement).
//
// The reaper tracks last-activity PER SANDBOX (keyed by sandbox id, tagged with
// its resource) in a Map-backed in-memory store (the same in-memory-default +
// persistence-seam shape as InMemoryQuotaStore). The LocalDriver calls `touch`
// on each schedule and `collectIdle(now)` from `reap(now)`.

/** A tracked sandbox: when it was last active and which resource it serves. */
interface Activity {
  resourceId: string;
  /** The injected-clock timestamp (seconds) of the last activity. */
  lastActiveAt: number;
}

/** What constructs an IdleReaper. `ttlSeconds` must be > 0. */
export interface IdleReaperOptions {
  /** Idle age (seconds) past which a sandbox is reaped to zero. Must be > 0. */
  ttlSeconds: number;
}

/**
 * Tracks per-sandbox idle age and decides which sandboxes to stop. `touch`
 * records activity at the injected `now`; `collectIdle(now)` returns the sandbox
 * ids whose idle age (`now - lastActiveAt`) exceeds the TTL. NO Date.now() - the
 * caller injects the clock, so the reap window is deterministic.
 */
export class IdleReaper {
  /** The idle TTL in seconds. A sandbox idle longer than this is reaped. */
  readonly ttlSeconds: number;
  /** Per-sandbox-id last-activity records (in-memory default). */
  private readonly activity = new Map<string, Activity>();

  constructor(opts: IdleReaperOptions) {
    if (opts.ttlSeconds <= 0) {
      throw new Error(
        `IdleReaper: ttlSeconds must be > 0 (got ${opts.ttlSeconds}).`,
      );
    }
    this.ttlSeconds = opts.ttlSeconds;
  }

  /**
   * Record activity for a sandbox at the injected `now` (seconds). Called on
   * every schedule so the reaper measures idle age from the last real use.
   * Defaults `now` to 0 so the LocalDriver's first-touch (which has no clock in
   * the driver-seam tests) is deterministic - the reap path always supplies a
   * real `now`.
   */
  touch(resourceId: string, sandboxId: string, now = 0): void {
    this.activity.set(sandboxId, { resourceId, lastActiveAt: now });
  }

  /**
   * Return the sandbox ids whose idle age exceeds the TTL as of `now`. Pure over
   * the injected clock + the tracked activity (no Date.now()). Deterministic
   * iteration order (insertion order) so the reap set is stable.
   */
  collectIdle(now: number): string[] {
    const idle: string[] = [];
    for (const [sandboxId, a] of this.activity) {
      if (now - a.lastActiveAt > this.ttlSeconds) {
        idle.push(sandboxId);
      }
    }
    return idle;
  }

  /** Stop tracking a sandbox (after it has been reaped/stopped). */
  forget(sandboxId: string): void {
    this.activity.delete(sandboxId);
  }

  /** How many sandboxes are still tracked as running for `resourceId`. */
  runningCount(resourceId: string): number {
    let n = 0;
    for (const a of this.activity.values()) {
      if (a.resourceId === resourceId) n += 1;
    }
    return n;
  }
}
