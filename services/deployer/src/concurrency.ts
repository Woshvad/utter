// concurrency.ts - the pure global-host concurrency-cap admission helper (H4 /
// SPEC §9.5 DoS mandate: "per-resource concurrency cap, GLOBAL HOST CAP, ... idle
// reaping").
//
// The reconcile loop must never (re)launch beyond a fixed number of running
// resource containers, or a host with finite memory/CPU is trivially exhausted by
// fan-out. admitLaunches takes the records the loop wants to (re)launch this tick
// plus the count already running and slices them at the remaining capacity: the
// ones that fit are ADMITTED, the rest are DEFERRED (NOT launched this tick) so the
// loop can surface the deferral loudly. It is PURE and deterministic (no Date,
// no random, no sort) and preserves input order, so a starved record keeps its
// place across ticks.
//
// This is a host-capacity control, NOT a money control: the cap is a count of
// containers the host can hold, never a USDC amount.
import type { DeploymentRecord } from "./stores/memory";

/**
 * The default global host cap. Derived from host memory headroom: roughly 256MB
 * per container on a 4GB host after the platform services, so about 10 resource
 * containers fit. Operator-tunable (the loop takes a maxConcurrent override); this
 * is a host-capacity number, not a money or scale literal.
 */
export const DEFAULT_MAX_CONCURRENT_RESOURCES = 10;

/** Inputs to {@link admitLaunches}. */
export interface AdmitLaunchesOpts {
  /** The records needing a (re)launch this tick (the reconcile result's toLaunch). */
  toLaunch: readonly DeploymentRecord[];
  /** The current count of RUNNING resource containers (the live host load). */
  runningCount: number;
  /** The global host cap (must be > 0). */
  maxConcurrent: number;
}

/** The split of {@link AdmitLaunchesOpts.toLaunch} at the remaining capacity. */
export interface AdmitLaunchesResult {
  /** The records that fit under the cap - launch now (input order preserved). */
  admit: DeploymentRecord[];
  /** The records over the cap - NOT launched this tick (surfaced as deferred). */
  deferred: DeploymentRecord[];
}

/**
 * Split the requested launches at the remaining host capacity. The capacity is
 * `maxConcurrent - runningCount` (floored at 0): the first `capacity` records are
 * admitted in input order, the rest are deferred. PURE and deterministic - no
 * Date, no random, no sort - so the admission is reproducible and a deferred
 * record keeps its position for the next tick.
 *
 * @throws if maxConcurrent <= 0 (a non-positive cap would admit nothing forever
 *         or be a misconfiguration; fail loud rather than silently stall).
 */
export function admitLaunches(opts: AdmitLaunchesOpts): AdmitLaunchesResult {
  if (opts.maxConcurrent <= 0) {
    throw new Error(
      `admitLaunches: maxConcurrent must be > 0 (got ${opts.maxConcurrent})`,
    );
  }
  const capacity = Math.max(0, opts.maxConcurrent - opts.runningCount);
  return {
    admit: opts.toLaunch.slice(0, capacity),
    deferred: opts.toLaunch.slice(capacity),
  };
}
