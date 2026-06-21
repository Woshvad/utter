// local-driver.ts - the in-process deterministic orchestrator (test/CI default).
//
// Mirrors apps/studio/app/adapter/fixture.ts (the in-process default half of the
// pluggable seam) + composes the Phase 3 SandboxRunner. The LocalDriver
// SCHEDULES the hardened RunSpec by passing it THROUGH to the injected
// SandboxRunner.run UNTOUCHED - it never builds or mutates a launch spec
// (T-08-UNHARDENED). It composes a WarmPool (bounds cold-start) and an
// IdleReaper (scale-to-zero on an injected-clock TTL); both are optional so the
// driver-seam tests can exercise the pass-through with only a runner.
//
// WARM-POOL WIRING (WR-01): the live LocalDriver actually USES the pool. `schedule`
// draws a warm sandbox when one is available (cold-start avoided) and, after serving
// the request, REPLENISHES the pool back up to `size` by launching spare sandboxes and
// releasing them into the pool for the next call. The replenishment runs off the hot
// path (it does not block the returned handle) but is tracked on a per-resource promise
// so the first call after idle is served warm and the pool is topped up for the next.
import type {
  RunSpec,
  RunHandle,
  SandboxRunner,
} from "@utter/sandbox";
import type { Orchestrator } from "./orchestrator.js";
import { WarmPool, DEFAULT_WARM_POOL_SIZE } from "./warm-pool.js";
import { IdleReaper } from "./reaper.js";

/** What the LocalDriver composes. Only `runner` is required (driver-seam tests). */
export interface LocalDriverDeps {
  /**
   * The Phase 3 SandboxRunner the orchestrator schedules through. For the
   * autonomous suite this is the in-memory/docker-dev runner; in production it
   * is the gvisor backend on the operator host. The orchestrator NEVER
   * re-implements isolation - it only calls `runner.run(spec)`.
   */
  runner: SandboxRunner;
  /**
   * The pre-warmed sandbox pool (bounds cold-start). Defaults to a pool of
   * DEFAULT_WARM_POOL_SIZE (the SINGLE source of truth; WR-02 - no inline `size: 1`).
   */
  warmPool?: WarmPool;
  /** The idle-TTL reaper (scale-to-zero). Defaults to a 60s-TTL reaper. */
  reaper?: IdleReaper;
}

/**
 * A scheduled run record: the resource it belongs to + the runner handle. The
 * reaper consults `lastActivity` (set on each schedule) to decide what to stop.
 */
interface ScheduledRun {
  resourceId: string;
  handle: RunHandle;
}

/**
 * The in-process orchestrator. `schedule` reuses a warm sandbox for the resource
 * when the pool has one (cold-start avoided) else launches one via
 * `runner.run(spec)` - the spec is passed THROUGH untouched. `reap(now)` stops
 * sandboxes whose idle age exceeds the TTL so an idle resource scales to zero.
 */
export class LocalDriver implements Orchestrator {
  readonly driver = "local" as const;
  private readonly runner: SandboxRunner;
  private readonly warmPool: WarmPool;
  private readonly reaper: IdleReaper;
  /** Live runs keyed by sandbox id, so reap() can stop the right containers. */
  private readonly runs = new Map<string, ScheduledRun>();
  /**
   * In-flight pool replenishment per resource (the off-hot-path top-up). Tracked so
   * a caller (and the live-path test) can await the pool reaching `size` after a
   * schedule, and so a second schedule does not over-launch a concurrent top-up.
   */
  private readonly replenishing = new Map<string, Promise<void>>();

  constructor(deps: LocalDriverDeps) {
    this.runner = deps.runner;
    // WR-02: ONE default warm-pool size (DEFAULT_WARM_POOL_SIZE) - no inline `size: 1`.
    this.warmPool = deps.warmPool ?? new WarmPool({ size: DEFAULT_WARM_POOL_SIZE });
    this.reaper = deps.reaper ?? new IdleReaper({ ttlSeconds: 60 });
  }

  async schedule(resourceId: string, spec: RunSpec): Promise<RunHandle> {
    // Reuse a pre-warmed sandbox for this resource if the pool has one
    // (cold-start avoided). The warm sandbox already ran the hardened spec.
    const warm = this.warmPool.acquire(resourceId);
    const handle = warm ?? (await this.runner.run(spec));
    this.runs.set(handle.id, { resourceId, handle });
    // Record activity so the reaper measures idle age from this schedule.
    this.reaper.touch(resourceId, handle.id);
    // WR-01: top the pool back up to `size` off the hot path so the NEXT call after
    // idle is served warm (bounded cold-start), instead of always cold-launching.
    this.scheduleReplenish(resourceId, spec);
    return handle;
  }

  /**
   * Kick off (or coalesce into) the off-hot-path top-up that brings the warm pool for
   * `resourceId` back up to `size`. It launches spare sandboxes via the SAME
   * SandboxRunner.run (the hardened spec passed THROUGH untouched) and releases them
   * into the pool. Returns immediately; the work is tracked on `replenishing` so a
   * concurrent schedule coalesces and a caller can await it via {@link warmupSettled}.
   */
  private scheduleReplenish(resourceId: string, spec: RunSpec): void {
    if (this.replenishing.has(resourceId)) return; // a top-up is already in flight
    // Defer to a MACROTASK so the top-up runs strictly OFF the hot path: schedule()
    // returns the served handle AND the caller's synchronous post-await code runs before
    // any replenish launch fires. The request-path launch is the ONLY run() call in the
    // call's critical path; the warm spares are launched lazily in the background.
    const task = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          // Launch until the pool is at `size` (release returns false once full, so we
          // stop the excess - the pool never grows past its configured ceiling).
          while (this.warmPool.warmCount(resourceId) < this.warmPool.size) {
            const spare = await this.runner.run(spec);
            if (!this.warmPool.release(resourceId, spare)) {
              // The pool filled concurrently; this spare is surplus - stop it, no leak.
              await this.runner.stop(spare.id);
              break;
            }
          }
        })().then(resolve, reject);
      }, 0);
    }).finally(() => {
      this.replenishing.delete(resourceId);
    });
    this.replenishing.set(resourceId, task);
  }

  /**
   * Await the in-flight warm-pool top-up for `resourceId` (a no-op if none is running).
   * The live path does not need to await it; the cold-start test uses it to deterministically
   * observe the pool being topped up after a schedule.
   */
  async warmupSettled(resourceId: string): Promise<void> {
    await this.replenishing.get(resourceId);
  }

  /** How many sandboxes are currently warm for `resourceId` (live-path introspection). */
  warmCount(resourceId: string): number {
    return this.warmPool.warmCount(resourceId);
  }

  async reap(now: number): Promise<void> {
    // The reaper decides which sandbox ids are idle past the TTL as of `now`
    // (injected clock). We stop each through the SAME SandboxRunner.stop - the
    // orchestrator owns no lifecycle of its own.
    const idle = this.reaper.collectIdle(now);
    const idleResources = new Set<string>();
    for (const sandboxId of idle) {
      idleResources.add(this.runs.get(sandboxId)?.resourceId ?? "");
      await this.runner.stop(sandboxId);
      this.runs.delete(sandboxId);
      this.reaper.forget(sandboxId);
    }
    // WR-01: an idle resource scales to ZERO - drain its warm pool too, otherwise the
    // pre-warmed spares the replenisher launched would stay running past the idle TTL
    // (defeating scale-to-zero). The drained warm sandboxes are stopped through the
    // SAME SandboxRunner.stop. A later call cold-launches + re-warms from scratch.
    for (const resourceId of idleResources) {
      if (!resourceId) continue;
      // Wait for any in-flight top-up so we drain a settled pool (no spare escapes).
      await this.warmupSettled(resourceId);
      for (const warm of this.warmPool.drain(resourceId)) {
        await this.runner.stop(warm.id);
      }
    }
  }
}
