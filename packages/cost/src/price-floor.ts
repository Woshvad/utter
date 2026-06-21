// SCL-06 priceFloor: a PURE function that keeps a listing's price above the
// platform's true cost. It compares `price` against `cost + margin`, all base-unit
// bigint (no float). The DEFAULT is soft-flag: a below-floor price returns "flag" -
// a non-blocking signal, so the call may still proceed while surfacing the loss.
// Hard-block is OPT-IN via config (08-RESEARCH Assumption A5 / CONTEXT SCL-06):
// then a below-floor price returns "block".
//
// No I/O, no clock, no randomness - referentially transparent. All comparison is in
// the same 6dp USDC lane the caller supplies; this function does no unit conversion.

/** The floor decision. */
export type FloorResult = "ok" | "flag" | "block";

/** The below-floor enforcement mode. soft-flag is the DEFAULT; hard-block opt-in. */
export type FloorMode = "soft-flag" | "hard-block";

/** Optional config; omit to get the soft-flag default. */
export interface PriceFloorOptions {
  /** Below-floor behaviour. Default "soft-flag" (non-blocking). */
  mode?: FloorMode;
}

/**
 * Compare `price` to `cost + margin` (all 6dp USDC base-unit bigint).
 *   price >= cost + margin            -> "ok"
 *   below floor, default (soft-flag)  -> "flag"  (non-blocking)
 *   below floor, hard-block opt-in    -> "block"
 */
export function priceFloor(
  price: bigint,
  cost: bigint,
  margin: bigint,
  options?: PriceFloorOptions,
): FloorResult {
  const floor = cost + margin;
  if (price >= floor) return "ok";
  const mode: FloorMode = options?.mode ?? "soft-flag";
  return mode === "hard-block" ? "block" : "flag";
}
