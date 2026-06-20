// strikes.ts - the pure 5-CONSECUTIVE-failure reducer + rolling health score
// (SCR-02/03).
//
// reduceStrike(state, probeResult, resourceId) is a PURE deterministic function
// (state, input) -> { state, transition } mirroring the (desired, actual) ->
// result reducer idiom in services/deployer/src/reconcile.ts:48-77. It performs NO
// I/O: it neither pauses the registry, flips the index, nor raises a slash on its
// own. Instead it returns a `transition` describing what HAPPENED, and the schedule
// loop drives the side-effects OUTSIDE the reducer (index.active=false,
// ResourceRegistry.pause, raise the bond-slash-review consumed by packages/staking),
// exactly as createReconcileLoop calls reapContainer off the pure reconcile result.
//
// Strike semantics (Pitfall 6 / SPEC §9.7 + CONTEXT): the limit is 5 CONSECUTIVE
// failures, NEVER a lifetime total. The reducer holds `consecutiveFailures`, zeroed
// on ANY passing probe - so a transient blip (even 4 failures) followed by one green
// probe does not deactivate a healthy endpoint. Deactivation happens exactly ON the
// transition from 4 -> 5 consecutive failures; later failures while already inactive
// do NOT re-raise a fresh bond-slash-review. A success while inactive resets the
// counter but does NOT auto-reactivate (reactivation is an explicit external
// decision).
import type { ProbeResult } from "./prober.js";

/** The number of CONSECUTIVE failing probes that deactivates a resource. */
export const STRIKE_LIMIT = 5 as const;

/**
 * The strike state for one resource. Pure data: the reducer derives the next state
 * from this plus a ProbeResult with no I/O. `consecutiveFailures` is CONSECUTIVE
 * (reset to 0 on any pass), never a lifetime total. `deactivatedAtProbe` marks the
 * probe count at which the 5th consecutive failure deactivated the resource.
 */
export interface StrikeState {
  /** Consecutive failing probes since the last passing probe (reset on any pass). */
  consecutiveFailures: number;
  /** A rolling 0..1 health score (EWMA over the pass/fail stream). */
  rollingScore: number;
  /** Whether the resource is currently verified/active. */
  active: boolean;
  /** The total probes folded so far (the deactivation marker references this). */
  probeCount: number;
  /** The probeCount at which the 5th consecutive failure deactivated the resource. */
  deactivatedAtProbe?: number;
}

/**
 * A bond-slash-review signal raised on deactivation and consumed by packages/staking
 * (STK-02). It is NOT an on-chain spend authorization: it is an explicit, reviewable
 * request for an operator/automated review to consider slashing the resource's bond.
 * The strike window boundary is documented per RESEARCH (open question Q1): it spans
 * the first of the 5 consecutive failing probes through deactivation.
 */
export interface BondSlashReview {
  /** The resource whose bond is up for slash review. */
  resourceId: string;
  /** A short, non-secret reason (e.g. "5 consecutive failing probes"). */
  reason: string;
  /** The consecutive-failure count at deactivation (always STRIKE_LIMIT here). */
  consecutiveFailures: number;
  /** The probeCount at which deactivation happened (the window end). */
  deactivatedAtProbe: number;
}

/**
 * The transition the reducer returns alongside the next state. `deactivated` is true
 * ONLY on the single probe that flips active true -> false; `bondSlashReview` is
 * present iff `deactivated`. The schedule loop reads this to drive the deactivation
 * side-effects OUTSIDE the pure reducer.
 */
export interface StrikeTransition {
  /** True only on the probe that deactivated the resource (the 5th consecutive failure). */
  deactivated: boolean;
  /** The slash-review signal, present iff `deactivated`. */
  bondSlashReview?: BondSlashReview;
}

/** The result of one reduce step: the next state + the transition that occurred. */
export interface StrikeStep {
  state: StrikeState;
  transition: StrikeTransition;
}

/**
 * The EWMA weight for the rolling score. The score is a smoothed pass(1)/fail(0)
 * average: nextScore = (1 - ALPHA) * prevScore + ALPHA * sample. With ALPHA=0.25 a
 * resource recovers/decays over a handful of probes, and a long healthy stream
 * drives the score toward 1 while a failing stream drives it toward 0. The score is
 * advisory health signal (it maps to the ERC-8004 giveFeedback value later); the
 * 5-consecutive counter, not the score, is the hard deactivation trigger.
 */
const ALPHA = 0.25;

/** The starting score: a freshly-listed resource begins fully healthy. */
const INITIAL_SCORE = 1;

/** The fresh strike state for a newly-tracked resource: active, no failures, full score. */
export function initialStrikeState(): StrikeState {
  return {
    consecutiveFailures: 0,
    rollingScore: INITIAL_SCORE,
    active: true,
    probeCount: 0,
  };
}

/**
 * Pure 5-consecutive-failure reduce step. Given the prior state and a ProbeResult,
 * returns the next state and the transition that occurred. NO I/O: deactivation
 * side-effects (index pause, registry pause, bond-slash-review) are described in the
 * returned transition for the loop to act on.
 *
 * - A passing probe (probeResult.passed === true) resets consecutiveFailures to 0
 *   and raises the rolling score. It NEVER auto-reactivates an inactive resource.
 * - A failing probe increments consecutiveFailures and lowers the rolling score. The
 *   transition from 4 -> 5 consecutive failures (while still active) deactivates the
 *   resource and raises a bond-slash-review. Failures beyond the 5th, or while
 *   already inactive, do NOT re-raise the signal.
 */
export function reduceStrike(
  state: StrikeState,
  probeResult: ProbeResult,
  resourceId: string,
): StrikeStep {
  const probeCount = state.probeCount + 1;
  const sample = probeResult.passed ? 1 : 0;
  const rollingScore = clamp01((1 - ALPHA) * state.rollingScore + ALPHA * sample);

  if (probeResult.passed) {
    // Any pass resets the CONSECUTIVE counter (Pitfall 6). It does not reactivate.
    return {
      state: {
        ...state,
        consecutiveFailures: 0,
        rollingScore,
        probeCount,
      },
      transition: { deactivated: false },
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  // Deactivate exactly on the transition from active to the strike limit. An already-
  // inactive resource, or a count past the limit, does NOT re-raise the signal.
  const deactivated = state.active && consecutiveFailures >= STRIKE_LIMIT;

  if (deactivated) {
    return {
      state: {
        ...state,
        consecutiveFailures,
        rollingScore,
        probeCount,
        active: false,
        deactivatedAtProbe: probeCount,
      },
      transition: {
        deactivated: true,
        bondSlashReview: {
          resourceId,
          reason: `${consecutiveFailures} consecutive failing probes`,
          consecutiveFailures,
          deactivatedAtProbe: probeCount,
        },
      },
    };
  }

  return {
    state: {
      ...state,
      consecutiveFailures,
      rollingScore,
      probeCount,
    },
    transition: { deactivated: false },
  };
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
