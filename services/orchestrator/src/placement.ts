// placement.ts - pure least-loaded bin-packing placement.
//
// Mirrors the observability registry pure helpers (deterministic, no clock, no
// random). `place` chooses the host with the lowest current load that is still
// under the per-host concurrency cap; ties are broken by the LOWEST host index
// so the decision is fully deterministic (CONTEXT SCL-01). There is NO
// Date.now() / Math.random() anywhere in the decision - placement must be
// reproducible for the same (hosts, load, cap) inputs.

/** A schedulable host: a stable id + its position in the host list (tie-break key). */
export interface Host {
  /** The host id (e.g. a Nomad node id or a local lane label). */
  id: string;
}

/** The result of a placement: the chosen host, or a no-capacity signal. */
export type PlacementResult =
  | { placed: true; hostId: string; index: number }
  | { placed: false; reason: "no-capacity" };

/**
 * Pick the least-loaded host under the per-host concurrency `cap`.
 *
 * - Scans hosts in index order; a host is eligible only if `load[host.id] < cap`.
 * - Among eligible hosts, picks the lowest current load.
 * - Ties (equal load) are broken by the LOWEST host index (the first scanned),
 *   so the choice is deterministic.
 * - Returns `{ placed: false, reason: "no-capacity" }` when every host is at the
 *   cap (no eligible host).
 *
 * Pure: depends only on its arguments. No wall-clock, no randomness.
 */
export function place(
  hosts: readonly Host[],
  load: Readonly<Record<string, number>>,
  cap: number,
): PlacementResult {
  let bestIndex = -1;
  let bestLoad = Number.POSITIVE_INFINITY;

  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    if (!host) continue;
    const current = load[host.id] ?? 0;
    if (current >= cap) continue; // at/over cap - not eligible
    // Strictly-less keeps the FIRST (lowest-index) host on a tie.
    if (current < bestLoad) {
      bestLoad = current;
      bestIndex = i;
    }
  }

  const best = bestIndex === -1 ? undefined : hosts[bestIndex];
  if (!best) {
    return { placed: false, reason: "no-capacity" };
  }
  return { placed: true, hostId: best.id, index: bestIndex };
}
