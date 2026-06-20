// computeMeteredAmount - the metered settle math (PAY-07, RESEARCH Pattern 2).
//
// computed = base + perKB*ceil(bytes/1024) + computeMultiplier*ceil(handlerMs/100)
// then clamped to the signed cap. MAX_RESPONSE_BYTES caps the size term so an
// oversize body cannot inflate the charge. ALL operands are bigint base units:
// there is intentionally NO `number` math on USDC amounts and NO `6`/`18`/`1e6`
// decimals literal - the cap and the pricing terms already arrive in base units
// (the cap from the signed authorization, the pricing terms as decimal strings).
import type { Pricing } from "./accepts";

/** Ceiling division for non-negative bigints: ceil(a / b). */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** One kibibyte - the size-term unit (bytes per size unit). */
const BYTES_PER_UNIT = 1024n;

/** One compute unit = 100ms of wall-clock handler time (cost proxy). */
const MS_PER_COMPUTE_UNIT = 100n;

/**
 * Compute the metered debit amount for a successful escrow call, clamped to the
 * buyer's signed cap.
 *
 * @param pricing      Per-resource metered pricing. `base`/`perKB`/`computeMultiplier`
 *                     are decimal strings in USDC base units; `maxResponseBytes`
 *                     (optional) caps the size term (MAX_RESPONSE_BYTES).
 * @param bodyBytes    The handler response size in bytes (number, a transport count).
 * @param handlerMs    Wall-clock handler duration in milliseconds (number).
 * @param cap          The signed spend cap in USDC base units (bigint). Hard ceiling.
 * @returns            min(computed, cap) in USDC base units (bigint).
 */
export function computeMeteredAmount(
  pricing: Pricing,
  bodyBytes: number,
  handlerMs: number,
  cap: bigint,
): bigint {
  const base = BigInt(pricing.base);
  const perKB = BigInt(pricing.perKB);
  const computeMultiplier = BigInt(pricing.computeMultiplier);

  // Cap the size term at MAX_RESPONSE_BYTES (if configured) so an oversize body
  // is charged as if it were exactly the cap, never more.
  const effectiveBytes =
    pricing.maxResponseBytes !== undefined
      ? Math.min(bodyBytes, pricing.maxResponseBytes)
      : bodyBytes;

  const sizeUnits = ceilDiv(BigInt(effectiveBytes), BYTES_PER_UNIT);
  const computeUnits = ceilDiv(BigInt(handlerMs), MS_PER_COMPUTE_UNIT);

  const computed = base + perKB * sizeUnits + computeMultiplier * computeUnits;

  // The signed cap is the hard ceiling: never debit more than the buyer authorized.
  return computed < cap ? computed : cap;
}
