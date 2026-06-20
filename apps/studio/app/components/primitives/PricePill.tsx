// PricePill - the per-call price chip. Money is mono + exact via UsdcAmount (the
// single render surface). A flat price shows the base; a metered price shows the
// base with a `<= cap` suffix (the "<= max metered" treatment from the UI-SPEC).
// The pill NEVER recomputes a price - it renders the base-unit values it is given.
import * as React from "react";
import { UsdcAmount } from "./UsdcAmount";

export interface PricePillProps {
  /** Per-call base price in token base units. */
  baseUnits: bigint;
  /** Decimals from a runtime read (passed straight to UsdcAmount). */
  decimals: number;
  /** "flat" or "metered" - metered shows the cap suffix. */
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
        "inline-flex items-center gap-2xs",
        "border border-hairline bg-raised",
        "px-xs py-2xs",
        "font-mono text-caption-mono text-ink",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <UsdcAmount baseUnits={baseUnits} decimals={decimals} />
      <span className="text-ink-faint">/call</span>
      {metered && capBaseUnits !== undefined ? (
        <span className="text-ink-muted">
          {"≤ "}
          <UsdcAmount baseUnits={capBaseUnits} decimals={decimals} />
          {" cap"}
        </span>
      ) : null}
    </span>
  );
}
