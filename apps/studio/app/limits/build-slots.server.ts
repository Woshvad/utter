// build-slots.server.ts - the true in-flight generation cap (S4, module singleton).
//
// Each build runs a claude-code subprocess that holds roughly 100-300MB, so this
// cap is the studio-side OOM guard: it bounds REAL concurrent builds regardless of
// what the fixed-window counters say (and unlike them it cannot be reset-exploited,
// because a slot is only freed when its build actually finishes). Default 3
// concurrent builds (MAX_CONCURRENT_BUILDS).
//
// SLOT DEADLINE (S4b): every held slot also carries a max-lifetime timer
// (BUILD_SLOT_MAX_MS, default 10 min). The awaited build work - the injected
// generate() drain loop and the deploy SSE reader - has no wall-clock bound of its
// own, so a wedged claude-code subprocess or a stalled deploy stream would hold its
// slot forever and, after MAX_CONCURRENT_BUILDS such wedges, brick /create until a
// process restart. The deadline auto-releases the slot so admission recovers; the
// real release in the create finally is idempotent, so a build that finishes after
// its deadline elapsed does not double-free. Releasing the slot does NOT kill the
// wedged subprocess (the slot is an admission counter, not a process supervisor) -
// it only stops one stuck build from denying capacity to everyone else.
import { parsePositiveInt } from "./fixed-window.server.js";

/** Thrown by acquire() when every build slot is taken. The create action catches
 *  this SPECIFICALLY and surfaces a capacity message, never the generic
 *  could-not-generate error. */
export class TooManyBuildsError extends Error {
  readonly code = "too_many_builds" as const;
  constructor(max: number) {
    super(`studio is at build capacity (${max} concurrent builds), try again in a few minutes`);
    this.name = "TooManyBuildsError";
  }
}

/**
 * A counting slot pool. acquire() returns an idempotent release function (double
 * release is safe and frees only one slot) or throws TooManyBuildsError when the
 * pool is full. Each slot self-releases after ttlMs so a wedged build cannot hold
 * capacity indefinitely.
 */
export class BuildSlots {
  private inFlight = 0;
  private readonly max: number;
  private readonly maxMs: number;

  constructor(max: number, maxMs = 600_000) {
    this.max = max;
    this.maxMs = maxMs;
  }

  /** The number of currently held slots (test/introspection only). */
  get active(): number {
    return this.inFlight;
  }

  /**
   * Take a slot. Returns an idempotent release. The slot auto-releases after ttlMs
   * (defaults to the pool's configured max lifetime; pass 0 to disable, used only in
   * tests that assert the no-deadline shape). unref'd so an in-flight deadline timer
   * never holds the process open.
   */
  acquire(ttlMs: number = this.maxMs): () => void {
    if (this.inFlight >= this.max) throw new TooManyBuildsError(this.max);
    this.inFlight += 1;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (timer) clearTimeout(timer);
    };
    if (ttlMs > 0) {
      timer = setTimeout(release, ttlMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    return release;
  }
}

/** The module singleton (the buildChannel pattern): constructed lazily from env on
 *  first use so every createResource shares one pool. */
let sharedSlots: BuildSlots | undefined;

export function buildSlots(): BuildSlots {
  if (!sharedSlots) {
    sharedSlots = new BuildSlots(
      parsePositiveInt(process.env.MAX_CONCURRENT_BUILDS, 3, "MAX_CONCURRENT_BUILDS"),
      parsePositiveInt(process.env.BUILD_SLOT_MAX_MS, 600_000, "BUILD_SLOT_MAX_MS"),
    );
  }
  return sharedSlots;
}

/** Test-only reset so a test's slot counters/timers never leak into the next. */
export function resetBuildSlotsForTests(): void {
  sharedSlots = undefined;
}
