// SCL-06 CostAttributor: sums the per-call platform cost.
//
// THE LOAD-BEARING RULE (08-RESEARCH Pitfall 5): relayer gas is native 18-dp and
// USDC revenue is 6-dp. They live in STRICTLY SEPARATE bigint lanes. NEVER a single
// bigint sums a gas value and a USDC value. The USDC-denominated components
// (hosting amortized warm-pool/compute time + data-proxy markup + model-call cost)
// sum into `usdcCost`; relayer gas stays in its own `gasCostNative` field.
//
// A unified comparable figure is produced ONLY by `toUsdcComparable`, at a clearly
// labeled boundary, using decimals read at RUNTIME (injected by the caller from an
// on-chain `decimals()` read via @utter/chain). There is no hardcoded decimals
// literal anywhere in this module's money path - the scale exponent is derived
// purely from the injected decimals values.
import type { Registry } from "@utter/observability";

/** Per-call cost inputs. USDC components are 6dp base units; gas is native 18dp. */
export interface CostInputs {
  /** Amortized warm-pool / compute time, USDC 6dp base units. */
  hostingBaseUnits: bigint;
  /** Relayer gas = tx gas * gasPrice, in the NATIVE 18-dp unit (kept separate). */
  gasNative18dp: bigint;
  /** Data-proxy markup, USDC 6dp base units. */
  proxyMarkupBaseUnits: bigint;
  /** Model-call cost, USDC 6dp base units. */
  modelCostBaseUnits: bigint;
}

/**
 * The per-call cost breakdown. Two STRICTLY separate lanes: `usdcCost` (6dp USDC
 * base units) and `gasCostNative` (native 18dp). They are never merged into one
 * bigint - a merge would add a native-18dp value to a 6dp value (Pitfall 5).
 */
export interface CostBreakdown {
  /** Hosting + proxy markup + model, summed in the 6dp USDC lane. */
  usdcCost: bigint;
  /** Relayer gas, held in its own native-18dp lane. */
  gasCostNative: bigint;
}

/** Decimals supplied at RUNTIME by the caller (from an on-chain decimals() read). */
export interface ComparableDecimals {
  /** Native gas unit decimals (e.g. 18 on Arc). Runtime read - no literal. */
  gasNativeDecimals: number;
  /** USDC ERC-20 decimals (e.g. 6 on Arc). Runtime read - no literal. */
  usdcDecimals: number;
}

export class CostAttributor {
  /**
   * Sum the per-call cost. The three USDC components add together in the 6dp lane;
   * relayer gas is carried untouched in the separate native-18dp lane. No
   * cross-unit arithmetic occurs here.
   */
  attribute(inputs: CostInputs): CostBreakdown {
    const usdcCost =
      inputs.hostingBaseUnits +
      inputs.proxyMarkupBaseUnits +
      inputs.modelCostBaseUnits;
    return {
      usdcCost,
      gasCostNative: inputs.gasNative18dp,
    };
  }

  /**
   * Produce a single USDC-comparable figure (6dp base units) for margin checks.
   * THIS is the only labeled boundary where gas crosses into the USDC unit. The
   * scale exponent is `gasNativeDecimals - usdcDecimals`, derived entirely from the
   * RUNTIME decimals the caller injects - no decimals literal. Gas (native 18dp) is
   * scaled DOWN to the USDC 6dp grain, then added to the USDC lane.
   */
  toUsdcComparable(breakdown: CostBreakdown, decimals: ComparableDecimals): bigint {
    const exponent = decimals.gasNativeDecimals - decimals.usdcDecimals;
    const scale = 10n ** BigInt(exponent);
    // After this division the value is in the USDC 6dp grain - it is no longer a
    // native-18dp gas value, so adding it to the USDC lane is unit-correct.
    const scaledToUsdcGrain = breakdown.gasCostNative / scale;
    return breakdown.usdcCost + scaledToUsdcGrain;
  }

  /**
   * Surface cost/call (per-call USDC cost) and cost/resource (per-resource USDC
   * cost) through the observability Registry. Both gauges hold 6dp base units and
   * render decimals-aware from a runtime decimals at Registry.render time. Gas is
   * NOT surfaced as a USDC gauge - it stays in its native lane.
   */
  emit(registry: Registry, breakdown: CostBreakdown): void {
    registry.costCallUsdc.set(breakdown.usdcCost);
    registry.costResourceUsdc.set(breakdown.usdcCost);
  }
}
