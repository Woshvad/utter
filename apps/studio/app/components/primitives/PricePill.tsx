// PricePill - the per-call price chip. Money is mono + exact via UsdcAmount (the
// single render surface). A flat price shows the base as "$X / call"; a metered
// price shows the cap as "<= $X" (the comp's "<= max" treatment). The pill NEVER
// recomputes a price - it renders the base-unit values it is given. The price text
// is the triad money accent (yellow) per the comp.
import * as React from "react";
import { UsdcAmount } from "./UsdcAmount";

export interface PricePillProps {
  /** Per-call base price in token base units. */
  baseUnits: bigint;
  /** Decimals from a runtime read (passed straight to UsdcAmount). */
  decimals: number;
  /** "flat" or "metered" - metered shows the cap instead of the base. */
  model: "flat" | "metered";
  /** The escrow cap in base units (only rendered when metered). */
  capBaseUnits?: bigint;
  className?: string;
}

export function PricePill({
  baseUnits,
  decimals,
  model,
  capBaseUnits,
  className,
}: PricePillProps): React.ReactElement {
  const metered = model === "metered";
  return (
    <span
      data-testid="price-pill"
      data-model={model}
      className={[
        "inline-flex items-center gap-2xs whitespace-nowrap",
        "border border-hairline",
        "px-[8px] py-[4px]",
        "font-mono text-[12px] text-yellow",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {metered && capBaseUnits !== undefined ? (
        <>
          <span aria-hidden="true">{"≤ "}</span>
          <UsdcAmount baseUnits={capBaseUnits} decimals={decimals} />
        </>
      ) : (
        <>
          <UsdcAmount baseUnits={baseUnits} decimals={decimals} />
          <span>{"/ call"}</span>
        </>
      )}
    </span>
  );
}
