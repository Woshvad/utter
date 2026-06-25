// reaper.ts - the pure runaway-container classifier (H4 / SPEC §9.5: the missing
// DURATION/AGGREGATE runaway control).
//
// cgroup caps (pids/mem/cpu) bound the RATE a container can burn, but they do not
// stop a wedged or crash-looping container from sitting on a host slot forever, nor
// a CPU-pegged one from holding the cap indefinitely. classifyRunaway is the cheap,
// stateless verdict the reconcile loop uses each tick to decide a container is
// runaway and must be quarantined + reaped:
//
//   1. Restart-loop signal: RestartCount has reached the on-failure cap, so the
//      container is wedged (it keeps dying and being restarted). This is the cheap,
//      always-available signal - RestartCount comes from a dockerode inspect.
//   2. Sustained-CPU signal: the container has held a high CPU fraction for N
//      consecutive observations. This needs per-container state across ticks, so
//      the classifier returns the running consecutive count for the loop to persist
//      and feed back in next tick. (Live CPU sampling is a documented follow-up;
//      the host adapter leaves cpuFraction undefined for now, so this signal stays
//      dormant until the stats stream lands - the classifier already supports it.)
//
// PURE: no Date, no random. The verdict carries a non-secret reason string (ids
// and counts only, never a key or secret).
import type { ActualContainer } from "./reconcile";

/** The thresholds that define a runaway container. */
export interface RunawayPolicy {
  /**
   * The restart-loop threshold: once RestartCount reaches this, the container is
   * wedged (the on-failure cap is exhausted). e.g. 5 == the DEFAULT_SERVICE_RESTART_POLICY
   * cap. This is a host-capacity bound, not a money literal.
   */
  maxRestartCount: number;
  /**
   * OPTIONAL sustained-CPU threshold as a fraction 0..1 of the container CPU cap
   * (e.g. 0.95). Omit to disable the CPU signal entirely.
   */
  cpuFraction?: number;
  /**
   * OPTIONAL number of CONSECUTIVE high-CPU observations before the CPU signal
   * trips (e.g. 3). Omit (with cpuFraction) to disable the CPU signal.
   */
  sustainedSamples?: number;
}

/**
 * The default runaway policy: trip on the restart cap (5, matching the default
 * on-failure max-retry) or on CPU held at >=95% for 3 consecutive samples. All
 * three are host-capacity numbers, not money or scale literals.
 */
export const DEFAULT_RUNAWAY_POLICY: RunawayPolicy = {
  maxRestartCount: 5,
  cpuFraction: 0.95,
  sustainedSamples: 3,
};

/** The verdict for one container this tick. */
export interface RunawayVerdict {
  /** True iff the container tripped a runaway signal this tick. */
  runaway: boolean;
  /** A non-secret reason (ids/counts only) when runaway; absent otherwise. */
  reason?: string;
  /**
   * The running count of consecutive high-CPU observations (this tick included).
   * Reset to 0 on any below-threshold sample. The loop persists this per container
   * and feeds it back in next tick so the sustained-CPU signal can accumulate.
   */
  consecutiveHighCpu: number;
}

/**
 * Classify whether a container is runaway this tick, given the policy and the
 * prior consecutive high-CPU count for THIS container.
 *
 * Restart-loop takes precedence in the reason when both signals trip. The CPU
 * signal only contributes when BOTH `policy.cpuFraction` and `c.cpuFraction` are
 * present (the host adapter leaves cpuFraction undefined for now, so the CPU signal
 * is dormant - the restart-loop signal still fires). PURE: no Date, no random.
 *
 * @param c the container's actual state (restartCount and optional cpuFraction).
 * @param policy the runaway thresholds.
 * @param priorConsecutiveHighCpu the consecutive high-CPU count from the prior tick
 *        for this container (0 if first seen).
 */
export function classifyRunaway(
  c: ActualContainer,
  policy: RunawayPolicy,
  priorConsecutiveHighCpu: number,
): RunawayVerdict {
  // Sustained-CPU bookkeeping first so consecutiveHighCpu is always returned, even
  // when the restart signal is the one that ultimately trips.
  const highCpu =
    policy.cpuFraction !== undefined &&
    c.cpuFraction !== undefined &&
    c.cpuFraction >= policy.cpuFraction;
  const consecutive = highCpu ? priorConsecutiveHighCpu + 1 : 0;

  // Restart-loop signal: the cheap, always-available verdict (RestartCount from a
  // dockerode inspect). Takes precedence in the reason when both trip.
  const restartCount = c.restartCount ?? 0;
  if (restartCount >= policy.maxRestartCount) {
    return {
      runaway: true,
      reason: `restart-loop: ${restartCount} restarts >= cap ${policy.maxRestartCount}`,
      consecutiveHighCpu: consecutive,
    };
  }

  // Sustained-CPU signal: trips only after `sustainedSamples` consecutive highs.
  if (
    policy.sustainedSamples !== undefined &&
    consecutive >= policy.sustainedSamples
  ) {
    return {
      runaway: true,
      reason: `cpu pegged: >=${policy.cpuFraction} for ${consecutive} samples`,
      consecutiveHighCpu: consecutive,
    };
  }

  return { runaway: false, consecutiveHighCpu: consecutive };
}
