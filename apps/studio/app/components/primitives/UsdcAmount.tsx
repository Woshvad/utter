// UsdcAmount - the SINGLE money-render surface for the whole Studio.
//
// Money discipline (CLAUDE.md / SPEC §2, the cross-phase rule): a USDC amount is
// rendered exactly, mono, and decimal-aware. The scale comes ONLY from the passed
// `decimals` prop, which itself is sourced from a runtime decimals() read
// (readUsdcBalance / UsdcBalance.decimals) - there is NO scale literal in this file.
// Every downstream money render (PricePill, BondBadge, charts, wallet) goes through
// here so the no-literal invariant has exactly one place to hold.
import * as React from "react";

export interface UsdcAmountProps {
  /** The on-chain amount in token base units (raw, never pre-scaled). */
  baseUnits: bigint;
  /** Decimals read from the contract at runtime. The ONLY source of scale. */
  decimals: number;
  /** Render the leading "$" sigil (default true). */
  sign?: boolean;
  /** Extra classes for layout; the mono/tabular treatment is always applied. */
  className?: string;
}

/**
 * Format a base-unit bigint to a fixed-decimal string using bigint divmod, so no
 * float precision is ever introduced. `ten ** scale` is built from the prop only.
 */
function formatBaseUnits(baseUnits: bigint, decimals: number): string {
  const scale = BigInt(decimals);
  const ten = 10n;
  const divisor = ten ** scale;
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / divisor;
  const remainder = abs % divisor;
  if (decimals === 0) {
    return `${negative ? "-" : ""}${whole}`;
  }
  const frac = remainder.toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function UsdcAmount({
  baseUnits,
  decimals,
  sign = true,
  className,
}: UsdcAmountProps): React.ReactElement {
  const formatted = formatBaseUnits(baseUnits, decimals);
  const cls = ["font-mono", "tabular-nums", className].filter(Boolean).join(" ");
  return (
    <span className={cls} data-testid="usdc-amount">
      {sign ? "$" : ""}
      {formatted}
    </span>
  );
}
