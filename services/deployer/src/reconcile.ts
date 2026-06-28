// reconcile.ts - the health/reconcile loop (DEP-05).
//
// The deploy control plane keeps the ACTUAL container state (read from dockerode
// `listContainers`) converging on the DESIRED state (the deployment records in the
// DeploymentStore). `reconcile(desired, actual)` is a PURE diff returning the drift:
//   - toLaunch: desired records with no running container (need a (re)launch),
//   - toReap:   actual containers with no desired record (orphans to reap, T-03-19),
//   - healthy:  true iff there is no drift in either direction.
//
// `createReconcileLoop` wires the store reader + an injected `listContainers`
// (normally dockerode, mocked in tests) into a `{tick, start, stop}`: `tick()`
// reads both sides and returns the reconcile result; `start/stop` manage the
// interval. The loop NEVER acts on the docker-dev backend as a security boundary -
// reconcile is liveness/health bookkeeping, not isolation.
import type { Hex } from "viem";
import type { DeploymentRecord, DeploymentStore } from "./stores/memory";
import { admitLaunches } from "./concurrency";
import { classifyRunaway, type RunawayPolicy } from "./reaper";

/**
 * One container in the ACTUAL state, as read from dockerode `listContainers` and
 * mapped to its resourceId (via the container's label, set at launch). The reconcile
 * loop matches these against the desired records by resourceId.
 */
export interface ActualContainer {
  /** The dockerode container id. */
  id: string;
  /** The resourceId this container serves (from its launch label). */
  resourceId: Hex;
  /** Whether the container is currently running (a stopped one needs a relaunch). */
  running: boolean;
  /**
   * The dockerode State.RestartCount (the runaway restart-loop signal). Optional so
   * existing callers/tests are unaffected; absent is treated as 0.
   */
  restartCount?: number;
  /**
   * The 0..1 fraction of the container CPU cap currently in use (the sustained-CPU
   * runaway signal). Optional - the host adapter leaves it undefined until live CPU
   * stats streaming lands; the classifier supports it for when it does.
   */
  cpuFraction?: number;
  /**
   * The resource slug (from the launch label) - lets reap drop the matching Traefik
   * dynamic file. Optional so existing callers/tests are unaffected.
   */
  slug?: string;
}

/** The drift between desired and actual state (the reconcile result). */
export interface ReconcileResult {
  /** Desired records with no running container - need a (re)launch. */
  toLaunch: DeploymentRecord[];
  /** Actual containers with no desired record - orphans to reap (T-03-19). */
  toReap: ActualContainer[];
  /** True iff there is no drift in either direction. */
  healthy: boolean;
}

/**
 * Pure desired-vs-actual diff. Only an ACTIVE record (status "running" or
 * "deploying") counts as desired-running; a "failed"/"stopped" record is NOT
 * desired, so (i) it is never put in `toLaunch` and (ii) a container still running
 * for it becomes a `toReap` orphan. This is what lets the runaway reaper QUARANTINE
 * a wedged container (set its record to "failed") and have the very next reconcile
 * refuse to relaunch it - no reap -> relaunch loop. Among active records a record
 * is satisfied ONLY by a RUNNING container for the same resourceId; a stopped (or
 * absent) container makes it a `toLaunch`. An actual container whose resourceId is
 * not an active desired record is a `toReap` orphan. `healthy` is true iff both
 * lists are empty.
 */
export function reconcile(
  desired: readonly DeploymentRecord[],
  actual: readonly ActualContainer[],
): ReconcileResult {
  // Only active records are desired-running; a failed/stopped record is excluded so
  // it is neither relaunched nor able to keep a container off the orphan list.
  const activeDesired = desired.filter(
    (d) => d.status === "running" || d.status === "deploying",
  );

  // Index actual containers by resourceId for O(1) lookup.
  const runningByResource = new Map<Hex, ActualContainer>();
  for (const c of actual) {
    // A later running container wins over an earlier stopped one for the same id.
    const existing = runningByResource.get(c.resourceId);
    if (!existing || (c.running && !existing.running)) {
      runningByResource.set(c.resourceId, c);
    }
  }
  const desiredResourceIds = new Set(activeDesired.map((d) => d.resourceId));

  // An active desired record needs a launch if it has no RUNNING container.
  const toLaunch = activeDesired.filter((d) => {
    const c = runningByResource.get(d.resourceId);
    return !c || !c.running;
  });

  // An actual container is an orphan if its resourceId is not desired.
  const toReap = actual.filter((c) => !desiredResourceIds.has(c.resourceId));

  return {
    toLaunch,
    toReap,
    healthy: toLaunch.length === 0 && toReap.length === 0,
  };
}

/** Options for {@link createReconcileLoop}. */
export interface ReconcileLoopOpts {
  /** The desired-state source (the deployment records). */
  store: DeploymentStore;
  /** Reads the ACTUAL container state (normally dockerode listContainers; injectable). */
  listContainers: () => Promise<ActualContainer[]>;
  /** The reconcile interval in ms (used by start/stop). */
  intervalMs: number;
  /**
   * ENFORCEMENT: stop + remove an orphan (toReap) container — an actual container
   * with no desired record. This is a security outcome (T-03-19): an orphaned,
   * unmanaged money-handling container MUST NOT be left running. The loop calls
   * this for every orphan on each tick. Injectable (normally dockerode
   * stop+remove); a tick where it is absent only REPORTS drift (and warns).
   */
  reapContainer?: (container: ActualContainer) => Promise<void>;
  /**
   * ENFORCEMENT: (re)launch a desired record (toLaunch) that has no running
   * container. Optional — a deployment pipeline may relaunch out-of-band; when
   * provided, the loop calls it for every toLaunch on each tick.
   */
  launchContainer?: (record: DeploymentRecord) => Promise<void>;
  /**
   * The global host concurrency cap (H4 / SPEC §9.5). When set together with
   * `launchContainer`, the loop admits at most this many RUNNING resource
   * containers: over-cap (re)launches are DEFERRED this tick and surfaced via
   * onError (phase "capacity"), never silently dropped. Absent = no cap (launch
   * all toLaunch, the prior behavior). A host-capacity number, not a money literal.
   */
  maxConcurrent?: number;
  /**
   * GC: sweep endpoint-less per-resource pairnets (quick 260625-mwb). When provided,
   * the loop calls this once per tick AFTER the orphan-container reap pass — a network
   * removed only after its last container is gone, so the sweep runs against a settled
   * container set. It is the safety net that closes the pairnet leak under crashes /
   * races where a pairnet outlives its containers. Best-effort: a failure is surfaced
   * via onError (phase "reap"), never propagated out of the tick. Absent = no sweep.
   */
  reapOrphanNetworks?: () => Promise<void>;
  /**
   * The runaway-container policy (H4 / SPEC §9.5). When set together with
   * `reapContainer`, the loop runs a runaway pass each tick: a container that is
   * restart-loop-wedged (or sustained-CPU-pegged) is QUARANTINED (its record set to
   * "failed" so reconcile will not relaunch it) and reaped, surfaced via onError
   * (phase "runaway"). Absent = no runaway pass.
   */
  runawayPolicy?: RunawayPolicy;
  /**
   * Stale-deploying quarantine timeout in ms (crash recovery). When set, the tick runs a
   * pass that flips any record stuck at status "deploying" longer than this window to
   * "failed" so its partial containers become reapable orphans the same tick. The deployer
   * never auto-relaunches generated bundles, so a "deploying" record left after a crash
   * would otherwise strand forever. Absent = the pass is a complete no-op (prior behavior).
   * A generous value (the env default is 10 min) keeps a slow-but-live deploy from being
   * wrongly failed. A host-timing number, never a money literal.
   */
  deployTimeoutMs?: number;
  /**
   * The clock, injectable for tests. Resolves to Date.now in prod. Used for BOTH the
   * runaway quarantine timestamp and the stale-deploying comparison so there is a single
   * now() source across the tick.
   */
  now?: () => number;
  /** Optional hook invoked with each tick's result (e.g. to act on drift / log health). */
  onTick?: (result: ReconcileResult) => void;
  /**
   * Surfaced when an enforcement action (reap/launch) or a tick fails. Defaults to
   * a `console.warn` that NEVER logs secret material (only the container id /
   * resourceId / error message). A failed reap of an untrusted container is a
   * security-relevant event and must be visible, not swallowed (WR-06).
   */
  onError?: (event: ReconcileErrorEvent) => void;
}

/** A surfaced reconcile/enforcement failure (never carries secret material). */
export interface ReconcileErrorEvent {
  /** What failed (or was deferred/quarantined). */
  phase: "tick" | "reap" | "launch" | "capacity" | "runaway" | "deploy-timeout";
  /** The container id (for a reap failure), if known. */
  containerId?: string;
  /** The resourceId involved, if known. */
  resourceId?: Hex;
  /** The error message (no secrets). */
  message: string;
}

/** The default error sink: a non-secret console.warn so a failed action is visible. */
function defaultOnError(event: ReconcileErrorEvent): void {
  const where = event.containerId ? ` container=${event.containerId}` : "";
  const who = event.resourceId ? ` resource=${event.resourceId}` : "";
  // No secret material: id/resourceId/message only.
  console.warn(`[reconcile] ${event.phase} failed${where}${who}: ${event.message}`);
}

/** A running reconcile loop: tick once on demand, or start/stop the interval. */
export interface ReconcileLoop {
  /** Read desired + actual ONCE and return the reconcile result. */
  tick(): Promise<ReconcileResult>;
  /** Begin ticking on the interval. Idempotent (a second start is a no-op). */
  start(): void;
  /** Stop the interval. Idempotent. */
  stop(): void;
}

/**
 * Build a reconcile loop over a store + an injected `listContainers`. `tick()`
 * reads the desired records (store.list) and the actual containers (listContainers),
 * diffs them via `reconcile`, ENFORCES the drift (reaps orphans + relaunches missing
 * records when the action hooks are provided), fires `onTick`, and returns the
 * result. `start/stop` manage a `setInterval` calling `tick()`; both are idempotent.
 * The interval is `unref`'d so a running loop never keeps the process alive on its
 * own.
 *
 * WR-04: the loop no longer merely reports drift. Orphan (toReap) containers — a
 * security outcome (T-03-19) — are stopped+removed via `reapContainer`. If no
 * `reapContainer` is provided AND there are orphans, the loop WARNS via `onError`
 * so a non-enforcing configuration is loud, not silent.
 *
 * H4 / SPEC §9.5: the tick also runs (when configured) a RUNAWAY pass before
 * reading desired state - a wedged/CPU-pegged container is quarantined (record ->
 * "failed") and reaped - and a host CONCURRENCY CAP at relaunch - over-cap launches
 * are deferred and surfaced, never silently dropped. Both are optional; absent =
 * the prior behavior.
 *
 * quick 260625-mwb: when `reapOrphanNetworks` is provided, the tick also sweeps
 * endpoint-less per-resource pairnets AFTER the orphan-container reap (the safety net
 * that closes the pairnet leak under crashes / races). A sweep failure is surfaced
 * (phase "reap"), never propagated.
 *
 * Crash recovery: when `deployTimeoutMs` is set, the tick also runs a STALE-DEPLOYING
 * quarantine pass (between the runaway pass and the desired read) - a record stuck at
 * "deploying" past the timeout is flipped to "failed" so its partial container becomes a
 * reapable orphan the same tick. It NEVER relaunches and NEVER touches a fresh deploying
 * record (an in-flight launch must finish). Absent = a complete no-op. The whole tick uses
 * a single injected `now` (`opts.now ?? Date.now`).
 */
export function createReconcileLoop(opts: ReconcileLoopOpts): ReconcileLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  const onError = opts.onError ?? defaultOnError;
  // Single clock for the whole tick (runaway timestamp + stale-deploying compare).
  // Unset in prod -> Date.now; tests inject a pinned clock.
  const now = opts.now ?? Date.now;
  // Per-container consecutive high-CPU counts, kept across ticks so the sustained-
  // CPU runaway signal can accumulate. Pruned each tick to the live container set so
  // it cannot grow unbounded.
  const consecutiveHighCpu = new Map<string, number>();

  async function tick(): Promise<ReconcileResult> {
    // Read actual FIRST so the runaway pass can quarantine wedged containers before
    // we read desired state (a quarantined record is then excluded from toLaunch).
    const actual = await opts.listContainers();

    // RUNAWAY pass (H4): when a policy is set, flag and quarantine+reap any wedged
    // or CPU-pegged container. SAFETY PROPERTY: a runaway container is NEVER removed
    // while its record is still relaunchable - quarantine-first AND reap-only-if-
    // quarantined. If the quarantine put throws (e.g. a Redis hiccup under host
    // stress), the container is left running (bounded by its cgroup caps) so the next
    // tick can re-attempt quarantine before any removal. Reaping a wedged container
    // whose record is still "running" would let the very next reconcile relaunch it -
    // the exact reap -> relaunch loop this feature exists to prevent (fail OPEN).
    const reapedIds = new Set<string>();
    if (opts.runawayPolicy) {
      const policy = opts.runawayPolicy;
      for (const c of actual) {
        const verdict = classifyRunaway(c, policy, consecutiveHighCpu.get(c.id) ?? 0);
        consecutiveHighCpu.set(c.id, verdict.consecutiveHighCpu);
        if (!verdict.runaway) continue;

        // ALWAYS surface the runaway detection itself (id/resourceId/reason only -
        // never a secret), distinct from any quarantine-failure message below.
        onError({
          phase: "runaway",
          containerId: c.id,
          resourceId: c.resourceId,
          message: verdict.reason ?? "runaway",
        });

        // Establish whether the container is SAFE to reap: only when its record is
        // durably quarantined (or there is no record / it was already failed).
        const rec = await opts.store.get(c.resourceId);
        let safeToReap: boolean;
        if (rec === null) {
          // No desired record => no relaunch risk; it is effectively an orphan.
          safeToReap = true;
        } else if (rec.status === "failed") {
          // Already quarantined => already unrelaunchable.
          safeToReap = true;
        } else {
          // Quarantine FIRST: set the record to "failed" so the next reconcile refuses
          // to relaunch it. Only mark safeToReap on a DURABLE put - if the put throws,
          // leave the container running and try again next tick (never reap it now).
          try {
            await opts.store.put({ ...rec, status: "failed", updatedAt: now() });
            safeToReap = true;
          } catch (err) {
            safeToReap = false;
            onError({
              phase: "runaway",
              containerId: c.id,
              resourceId: c.resourceId,
              message: "quarantine failed: " + (err instanceof Error ? err.message : String(err)),
            });
          }
        }

        // Reap ONLY when durably quarantined. A failed reap is surfaced, not
        // swallowed, and is NOT added to reapedIds - with the record now "failed" the
        // container is a toReap orphan, so the existing orphan pass remains its safe
        // fallback path next tick.
        if (safeToReap && opts.reapContainer) {
          try {
            await opts.reapContainer(c);
            reapedIds.add(c.id);
          } catch (err) {
            onError({
              phase: "runaway",
              containerId: c.id,
              resourceId: c.resourceId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      // Prune per-container state for containers that no longer exist (no unbounded
      // growth across ticks).
      const liveIds = new Set(actual.map((c) => c.id));
      for (const id of [...consecutiveHighCpu.keys()]) {
        if (!liveIds.has(id)) consecutiveHighCpu.delete(id);
      }
    }

    // STALE-DEPLOYING quarantine pass (crash recovery). A record stuck at "deploying"
    // is treated as desired-running (the status filter), so it is never reaped, yet the
    // deployer never auto-relaunches generated bundles - so a "deploying" record left
    // behind by a crash (written before the deploy resolved) strands forever and its
    // partial containers, sharing its resourceId, are never reaped. Flip any record older
    // than the timeout to "failed" so the activeDesired filter drops it below and its
    // partial container becomes a reapable orphan THIS tick. Runs BEFORE the desired read
    // and BEFORE the orphan reap. A FRESH deploying record (inside the window) is left
    // untouched so an in-flight launch can finish. There is NO relaunch path: a flip only
    // removes the record from desired; untrusted generated code is never re-run. Absent
    // timeout => the pass is a complete no-op (prior behavior byte-unchanged).
    if (opts.deployTimeoutMs !== undefined) {
      const deployTimeoutMs = opts.deployTimeoutMs;
      const records = await opts.store.list();
      for (const rec of records) {
        if (rec.status !== "deploying") continue;
        if (now() - rec.updatedAt <= deployTimeoutMs) continue;
        try {
          // The spread preserves agentId/resourceId/slug/deployVersion/cap; only status
          // and updatedAt change.
          await opts.store.put({ ...rec, status: "failed", updatedAt: now() });
          onError({
            phase: "deploy-timeout",
            resourceId: rec.resourceId,
            // WR-06: resourceId + a static message only. Never the bundle/cap/slug.
            message: `deploying record stale > ${deployTimeoutMs}ms; quarantined to failed`,
          });
        } catch (err) {
          onError({
            phase: "deploy-timeout",
            resourceId: rec.resourceId,
            message: "quarantine failed: " + (err instanceof Error ? err.message : String(err)),
          });
        }
      }
    }

    // Read desired AFTER quarantine so any record just set to "failed" is excluded
    // from desired-running (reconcile's status filter).
    const desired = await opts.store.list();
    const result = reconcile(desired, actual);

    // ENFORCE: reap orphan containers (no desired record). Never leave an orphan
    // money-handling container alive (T-03-19). A failed reap is surfaced, not
    // swallowed (WR-06). Skip any container already reaped by the runaway pass.
    const orphans = result.toReap.filter((c) => !reapedIds.has(c.id));
    if (orphans.length > 0) {
      if (opts.reapContainer) {
        for (const orphan of orphans) {
          try {
            await opts.reapContainer(orphan);
          } catch (err) {
            onError({
              phase: "reap",
              containerId: orphan.id,
              resourceId: orphan.resourceId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        // No enforcement hook but orphans exist: make the gap loud.
        onError({
          phase: "reap",
          message: `${orphans.length} orphan container(s) detected but no reapContainer enforcement hook is configured`,
        });
      }
    }

    // GC: sweep endpoint-less per-resource pairnets (quick 260625-mwb). Runs AFTER the
    // orphan-container reap so a network is only swept once its last container is gone.
    // A failure is surfaced (phase "reap"), never propagated out of the tick.
    if (opts.reapOrphanNetworks) {
      try {
        await opts.reapOrphanNetworks();
      } catch (err) {
        onError({
          phase: "reap",
          message: "orphan-network sweep failed: " + (err instanceof Error ? err.message : String(err)),
        });
      }
    }

    // ENFORCE: (re)launch desired records with no running container, when a launch
    // hook is provided. A failed launch is surfaced, not swallowed. When a host cap
    // is set, admit only what fits and surface the deferred remainder (phase
    // "capacity"); over-cap launches are never silently dropped.
    if (opts.launchContainer && result.toLaunch.length > 0) {
      let toLaunch = result.toLaunch;
      if (opts.maxConcurrent !== undefined) {
        const runningCount = actual.filter((c) => c.running).length;
        const { admit, deferred } = admitLaunches({
          toLaunch: result.toLaunch,
          runningCount,
          maxConcurrent: opts.maxConcurrent,
        });
        toLaunch = admit;
        if (deferred.length > 0) {
          onError({
            phase: "capacity",
            message: `${deferred.length} launch(es) deferred: host cap ${opts.maxConcurrent} reached (running ${runningCount})`,
          });
        }
      }
      for (const rec of toLaunch) {
        try {
          await opts.launchContainer(rec);
        } catch (err) {
          onError({
            phase: "launch",
            resourceId: rec.resourceId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    opts.onTick?.(result);
    return result;
  }

  function start(): void {
    if (timer !== null) return; // idempotent: already running
    timer = setInterval(() => {
      // A transient dockerode error must never crash the loop, but it MUST be
      // visible (WR-06): surface it via onError instead of swallowing. The next
      // tick re-reads fresh state.
      void tick().catch((err) => {
        onError({
          phase: "tick",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, opts.intervalMs);
    // Don't let the reconcile timer keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (timer === null) return; // idempotent: already stopped
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
