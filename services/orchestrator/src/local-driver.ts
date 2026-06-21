// local-driver.ts - the in-process deterministic orchestrator (test/CI default).
//
// Mirrors apps/studio/app/adapter/fixture.ts (the in-process default half of the
// pluggable seam) + composes the Phase 3 SandboxRunner. The LocalDriver
// SCHEDULES the hardened RunSpec by passing it THROUGH to the injected
// SandboxRunner.run UNTOUCHED - it never builds or mutates a launch spec
// (T-08-UNHARDENED). It composes a WarmPool (bounds cold-start) and an
// IdleReaper (scale-to-zero on an injected-clock TTL); both are optional so the
// driver-seam tests can exercise the pass-through with only a runner.
import type {
  RunSpec,
  RunHandle,
  SandboxRunner,
} from "@utter/sandbox";
import type { Orchestrator } from "./orchestrator.js";
import { WarmPool } from "./warm-pool.js";
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
  /** The pre-warmed sandbox pool (bounds cold-start). Defaults to a size-1 pool. */
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

  constructor(deps: LocalDriverDeps) {
    this.runner = deps.runner;
    this.warmPool = deps.warmPool ?? new WarmPool({ size: 1 });
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
    return handle;
  }

  async reap(now: number): Promise<void> {
    // The reaper decides which sandbox ids are idle past the TTL as of `now`
    // (injected clock). We stop each through the SAME SandboxRunner.stop - the
    // orchestrator owns no lifecycle of its own.
    const idle = this.reaper.collectIdle(now);
    for (const sandboxId of idle) {
      await this.runner.stop(sandboxId);
      this.runs.delete(sandboxId);
      this.reaper.forget(sandboxId);
    }
  }
}
