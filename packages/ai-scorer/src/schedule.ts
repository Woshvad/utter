// schedule.ts - the scheduled re-scoring loop (SCR-01 schedule half).
//
// createScoringLoop mirrors createReconcileLoop (services/deployer/src/reconcile.ts
// :156-234): a { tick, start, stop } over an injected source + an injected actor.
// `tick()` probes EACH tracked resource via the injectable ResourceProber, folds the
// ProbeResult through the PURE reduceStrike, persists the next state, and invokes
// `applyResult` for the side-effects (index.active=false, ResourceRegistry.pause,
// raise the bond-slash-review) - keeping every side-effect OUTSIDE the reducer,
// exactly as createReconcileLoop calls reapContainer off the pure reconcile result.
// `start()` is idempotent and uses setInterval+unref so a running loop never keeps
// the process alive; `stop()` clears the timer. The schedule is fake-clock testable
// (vi.useFakeTimers); the live cron over `*.resources.<domain>` is operator-gated and
// inherits the LiveHttpsProber host prerequisite.
import type { ProbeResult, ProbeTarget, ResourceProber } from "./prober.js";
import { reduceStrike, type StrikeState, type StrikeTransition } from "./strikes.js";

/** The event handed to `applyResult` after each resource is probed + reduced. */
export interface ApplyResultEvent {
  /** The resource that was probed. */
  resourceId: string;
  /** The probe outcome this tick. */
  result: ProbeResult;
  /** The next strike state after folding the result. */
  state: StrikeState;
  /**
   * The reducer transition. When `transition.deactivated` is true the caller drives
   * the deactivation side-effects (index inactive + registry pause + the
   * bond-slash-review on `transition.bondSlashReview`). These side-effects live HERE,
   * OUTSIDE the pure reducer.
   */
  transition: StrikeTransition;
}

/** A surfaced scoring-loop failure (never carries secret material). */
export interface ScoringErrorEvent {
  /** What failed. */
  phase: "tick" | "probe" | "apply";
  /** The resourceId involved, if known. */
  resourceId?: string;
  /** The error message (no secrets). */
  message: string;
}

/** Options for {@link createScoringLoop}. */
export interface ScoringLoopOpts {
  /** The injectable prober (FixtureProber autonomously; LiveHttpsProber operator-gated). */
  prober: ResourceProber;
  /** The tracked resources to probe each tick. */
  resources: () => ProbeTarget[] | Promise<ProbeTarget[]>;
  /** Read the current strike state for a resource (the loop folds onto it). */
  getState: (resourceId: string) => StrikeState;
  /** Persist the next strike state for a resource. */
  setState: (resourceId: string, state: StrikeState) => void;
  /**
   * Drive the deactivation side-effects from the reducer transition - index inactive,
   * ResourceRegistry.pause, raise the bond-slash-review. Called for EVERY probed
   * resource; the caller branches on `event.transition.deactivated`. Keeping this
   * OUTSIDE the reducer is the T-05-03-SIDEEFFECT mitigation: the slash trigger is an
   * explicit, reviewable transition, never a hidden effect of the pure function.
   */
  applyResult: (event: ApplyResultEvent) => void | Promise<void>;
  /** The re-scoring interval in ms (used by start/stop). */
  intervalMs: number;
  /**
   * Surfaced when a probe, an applyResult, or a tick fails. Defaults to a
   * `console.warn` that NEVER logs secret material (only the resourceId + message). A
   * transient probe error must be visible, not swallowed (mirrors reconcile WR-06).
   */
  onError?: (event: ScoringErrorEvent) => void;
}

/** A running scoring loop: tick once on demand, or start/stop the interval. */
export interface ScoringLoop {
  /** Probe + reduce + apply for every tracked resource ONCE. */
  tick(): Promise<void>;
  /** Begin ticking on the interval. Idempotent (a second start is a no-op). */
  start(): void;
  /** Stop the interval. Idempotent. */
  stop(): void;
}

/** The default error sink: a non-secret console.warn so a failed action is visible. */
function defaultOnError(event: ScoringErrorEvent): void {
  const who = event.resourceId ? ` resource=${event.resourceId}` : "";
  // No secret material: resourceId + message only.
  console.warn(`[scoring] ${event.phase} failed${who}: ${event.message}`);
}

/**
 * Build a scoring loop over an injected prober + state store. `tick()` reads the
 * tracked resources, probes each via the prober, folds the result through
 * reduceStrike, persists the next state, and calls `applyResult` for the side-effects
 * (deactivation pause/slash-review when the transition says so). A per-resource probe
 * or apply error is surfaced via `onError` and does NOT abort the rest of the tick.
 * `start/stop` manage a `setInterval` calling `tick()`; both are idempotent and the
 * interval is `unref`'d so a running loop never keeps the process alive on its own.
 */
export function createScoringLoop(opts: ScoringLoopOpts): ScoringLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  const onError = opts.onError ?? defaultOnError;

  async function tick(): Promise<void> {
    const targets = await opts.resources();
    for (const target of targets) {
      let result: ProbeResult;
      try {
        result = await opts.prober.probe(target);
      } catch (err) {
        onError({
          phase: "probe",
          resourceId: target.resourceId,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const prev = opts.getState(target.resourceId);
      const { state, transition } = reduceStrike(prev, result, target.resourceId);
      opts.setState(target.resourceId, state);

      try {
        await opts.applyResult({ resourceId: target.resourceId, result, state, transition });
      } catch (err) {
        onError({
          phase: "apply",
          resourceId: target.resourceId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function start(): void {
    if (timer !== null) return; // idempotent: already running
    timer = setInterval(() => {
      // A transient probe/store error must never crash the loop, but it MUST be
      // visible: surface it via onError instead of swallowing. The next tick re-reads
      // fresh state.
      void tick().catch((err) => {
        onError({
          phase: "tick",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, opts.intervalMs);
    // Don't let the re-scoring timer keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (timer === null) return; // idempotent: already stopped
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
