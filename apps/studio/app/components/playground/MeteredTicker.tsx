// MeteredTicker - the metered-price ticking beat (UI-SPEC §Metered ticker).
//
// As the response returns, the displayed metered price counts UP to the computed
// amount, which is itself CLAMPED TO THE SIGNED CAP. The math is NOT re-implemented:
// it calls computeMeteredAmount from @utter/x402-arc (the frozen gate math), so the
// displayed value can NEVER exceed the cap (T-06-OVERCAP). Money renders only through
// UsdcAmount; there is NO 1e6/6 literal in this file (the cap + pricing terms arrive in
// base units; the decimals format comes from the runtime-read `decimals` prop).
import * as React from "react";
import { computeMeteredAmount, type Pricing } from "@utter/x402-arc";
import { UsdcAmount } from "../primitives/UsdcAmount.js";

export interface MeteredTickerProps {
  /** The metered pricing block (decimal-string base-unit terms). */
  pricing: Pricing;
  /** The signed spend cap in base units - the hard ceiling the ticker clamps to. */
  cap: bigint;
  /** Decimals from a runtime read (the only scale source). */
  decimals: number;
  /** The handler response size in bytes (drives the size term). */
  bodyBytes: number;
  /** The handler wall-clock duration in ms (drives the compute term). */
  handlerMs: number;
  /** When false, render the final value immediately (tests / reduced-motion). */
  animate?: boolean;
}

export function MeteredTicker({
  pricing,
  cap,
  decimals,
  bodyBytes,
  handlerMs,
  animate = true,
}: MeteredTickerProps): React.ReactElement {
  // The gate math (clamped to cap) - never re-implemented here.
  const target = computeMeteredAmount(pricing, bodyBytes, handlerMs, cap);

  const [shown, setShown] = React.useState<bigint>(animate ? 0n : target);

  React.useEffect(() => {
    if (!animate) {
      setShown(target);
      return;
    }
    // Respect reduced-motion: snap to the target.
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(target);
      return;
    }
    // Count up in a few discrete steps toward the target; the displayed value is always
    // min(step, target) <= cap (target is already clamped to cap, so this never exceeds it).
    const steps = 12;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      // Interpolate in base units via bigint arithmetic (no float on money).
      const next = (target * BigInt(i)) / BigInt(steps);
      setShown(next > target ? target : next);
      if (i >= steps) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [target, animate]);

  const isMetered = pricing.model === "metered";

  return (
    <div
      data-testid="metered-ticker"
      aria-live="polite"
      className="inline-flex items-baseline gap-xs font-mono tabular-nums"
    >
      {/* the footer metered value: 18px bold yellow (the comp's metered figure) */}
      <span
        data-testid="metered-value"
        className="font-mono text-[18px] font-bold text-yellow"
      >
        <UsdcAmount baseUnits={shown} decimals={decimals} />
      </span>
      {isMetered ? (
        <span data-testid="metered-cap" className="text-caption-mono text-ink-faint lowercase">
          {"≤ "}
          <UsdcAmount baseUnits={cap} decimals={decimals} sign />
          {" cap"}
        </span>
      ) : null}
    </div>
  );
}
