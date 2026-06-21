// @utter/cost - the SCL-06 home: per-call cost attribution + price floors,
// surfaced through the Phase 6 observability registry (SPEC §12; CONTEXT
// "packages/cost").
//
// CostAttributor (sums hosting + relayer gas + data-proxy markup + model-call
// cost) and the priceFloor check (soft-flag default / hard-block opt-in).
//
// UNIT DISCIPLINE NOTE: relayer gas is native 18-decimal and USDC revenue is
// 6-decimal; they are kept in STRICTLY separate lanes - never a single bigint
// summing a gas value and a USDC value (Pitfall 5). Conversion happens only at a
// clearly-labeled boundary with a runtime decimals() read; no decimals literal.

export {
  CostAttributor,
  type CostInputs,
  type CostBreakdown,
  type ComparableDecimals,
} from "./cost-attributor";
