// RevenuePanel - the STU-04 revenue summary panel. Every money figure renders
// through the single UsdcAmount surface (mono, 6dp-aware, NO 1e6/6/18 literal); the
// creator/platform split is the projected RevenueSummary value, NOT recomputed here
// (T-06-REDERIVE). The dashboard leads yellow (money) per the color discipline:
// revenue figures + the revenue chart are yellow, the calls chart is blue.
//
// The BauhausChart plots plain numeric series. When a money series is charted, the
// base units are scaled to a display number via the SAME runtime-decimals path
// UsdcAmount uses (`scaleToDisplay`) - there is no money-scale literal here either.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { BauhausChart, type ChartPoint } from "../charts/BauhausChart";
import type { RevenueSummary } from "../../adapter/types";

export interface RevenuePanelProps {
  /** The read-through revenue summary (calls/gross/shares/refunds + receipts). */
  revenue: RevenueSummary;
  /** Runtime USDC decimals (from getEscrowBalance/readUsdcBalance). The ONLY scale. */
  decimals: number;
}

/**
 * Scale a base-unit bigint to a display number for the chart, using ONLY the runtime
 * decimals (built as 10n ** BigInt(decimals)) - no money-scale literal. The chart
 * needs a plain number; we keep full precision through the bigint divmod and only
 * lose precision at the final Number() for the visual bar height.
 */
function scaleToDisplay(baseUnits: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const frac = baseUnits % divisor;
  // Compose whole.frac as a number for the bar height only (display, not money math).
  return Number(whole) + Number(frac) / Number(divisor);
}

/** A single labelled money figure, rendered mono via UsdcAmount. */
function Figure({
  label,
  baseUnits,
  decimals,
  emphasis,
}: {
  label: string;
  baseUnits: bigint;
  decimals: number;
  emphasis?: boolean;
}): React.ReactElement {
  return (
    <div data-testid={`revenue-figure-${label}`} className="flex flex-col gap-2xs">
      <span className="text-label font-display lowercase text-ink-muted">{label}</span>
      <UsdcAmount
        baseUnits={baseUnits}
        decimals={decimals}
        className={emphasis ? "text-display-sm text-yellow" : "text-heading text-ink"}
      />
    </div>
  );
}

export function RevenuePanel({ revenue, decimals }: RevenuePanelProps): React.ReactElement {
  // Revenue chart series (yellow): gross / creator / platform / refunds, scaled to a
  // display number via the runtime-decimals path (no literal).
  const revenueSeries: ChartPoint[] = [
    { label: "gross", value: scaleToDisplay(revenue.gross, decimals) },
    { label: "creator", value: scaleToDisplay(revenue.creatorShare, decimals) },
    { label: "platform", value: scaleToDisplay(revenue.platformShare, decimals) },
    { label: "refunds", value: scaleToDisplay(revenue.refunds, decimals) },
  ];
  // Calls chart series (blue): a single calls bar (plain count, never money).
  const callsSeries: ChartPoint[] = [{ label: "calls", value: revenue.calls }];

  return (
    <section data-testid="revenue-panel" className="flex flex-col gap-lg">
      {/* the money figures - yellow leads (revenue is the hero figure) */}
      <div className="grid grid-cols-2 gap-lg md:grid-cols-4">
        <Figure label="gross" baseUnits={revenue.gross} decimals={decimals} emphasis />
        <Figure label="creator" baseUnits={revenue.creatorShare} decimals={decimals} />
        <Figure label="platform" baseUnits={revenue.platformShare} decimals={decimals} />
        <Figure label="refunds" baseUnits={revenue.refunds} decimals={decimals} />
      </div>

      {/* calls is a plain count, mono numeric, never money */}
      <div data-testid="revenue-calls" className="flex items-baseline gap-xs">
        <span className="text-label font-display lowercase text-ink-muted">calls</span>
        <span className="font-mono tabular-nums text-heading text-ink">{revenue.calls}</span>
      </div>

      {/* charts: revenue=yellow, calls=blue (the color discipline) */}
      <div className="grid grid-cols-1 gap-lg md:grid-cols-2">
        <div className="flex flex-col gap-xs">
          <span className="text-label font-display lowercase text-ink-muted">revenue</span>
          <BauhausChart series={revenueSeries} color="yellow" ariaLabel="revenue breakdown in usdc" />
        </div>
        <div className="flex flex-col gap-xs">
          <span className="text-label font-display lowercase text-ink-muted">calls</span>
          <BauhausChart series={callsSeries} color="blue" ariaLabel="total settled calls" />
        </div>
      </div>
    </section>
  );
}
