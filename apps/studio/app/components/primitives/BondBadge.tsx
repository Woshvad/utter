// BondBadge - the staked-bond chip shown on every card / detail (the "skin in the
// game" signal). Bonded amount is mono + exact via UsdcAmount. Legible without
// color: it carries a square glyph (bond = a posted block) + the literal "bond"
// label, so meaning is shape + text, never color alone.
import * as React from "react";
import { UsdcAmount } from "./UsdcAmount";

export interface BondBadgeProps {
  /** The posted bond in token base units. */
  bond: bigint;
  /** Decimals from a runtime read. */
  decimals: number;
  className?: string;
}

export function BondBadge({ bond, decimals, className }: BondBadgeProps): React.ReactElement {
  const hasBond = bond > 0n;
  return (
    <span
      data-testid="bond-badge"
      data-has-bond={hasBond}
      className={[
        "inline-flex items-center gap-2xs",
        "border border-hairline",
        "px-xs py-2xs",
        "font-mono text-caption-mono text-ink-muted",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* square = posted block / bond */}
      <span
        aria-hidden="true"
        className="inline-block"
        style={{ width: 8, height: 8, background: "var(--yellow)" }}
      />
      <span className="text-ink-faint lowercase">bond</span>
      <UsdcAmount baseUnits={bond} decimals={decimals} />
    </span>
  );
}
