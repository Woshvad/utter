// RevenuePanel - the STU-04 revenue summary panel (comp 643-663).
//
// Two regions: (1) four stat cells in the signature seamless 1px hairline grid
// (gap-px over a bg-hairline wrapper, each cell bg-raised) - TOTAL EARNINGS (yellow,
// the money hero) / CALLS - 30D (blue) / LIVE APIS / STRIKES; (2) two chart cards
// with a color-dot title each - "revenue - usdc / month" (yellow) and "calls /
// month" (blue) - each a 12-bar BauhausChart.
//
// Money discipline: TOTAL EARNINGS renders through the single UsdcAmount surface
// (mono, decimal-aware, NO 1e6/6/18 literal); the aggregate is the projected
// read-through creator earnings, NOT recomputed here (T-06-REDERIVE). The dashboard
// leads yellow (money). The two charts plot REAL per-resource data (each active
// resource's read-through earnings and settled calls from the loader's rows) - there
// is no fabricated series and no sample badge. Bar HEIGHTS are proportional (Number of
// the base-unit earnings, normalized by the chart), never a decimal-scaled money render.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { BauhausChart, type ChartPoint, type TriadColor } from "../charts/BauhausChart";

/** The minimal per-resource shape the charts plot (a structural subset of ResourceRow). */
export interface RevenueChartRow {
  /** The resource slug (the bar label). */
  slug: string;
  /** The resource's read-through creator earnings in base units (the revenue bar height). */
  revenue: bigint;
  /** The resource's settled call count (the calls bar height). */
  calls: number;
}

export interface RevenuePanelProps {
  /** Aggregate creator earnings across all resources, base units (read-through). */
  earnings: bigint;
  /** Total settled calls across all resources. */
  totalCalls: number;
  /** Count of currently-active (live) resources. */
  liveApis: number;
  /** Active strikes / alerts count. */
  strikes: number;
  /** Runtime USDC decimals (from getEscrowBalance). The ONLY money scale. */
  decimals: number;
  /** The per-resource rows the two charts plot (real earnings + calls; empty => empty state). */
  rows: RevenueChartRow[];
}

/** Format an integer count with thousands separators (locale-stable grouping). */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** One stat cell of the seamless 1px grid: mono label + mono value. */
function StatCell({
  label,
  children,
  testid,
}: {
  label: string;
  children: React.ReactNode;
  testid: string;
}): React.ReactElement {
  return (
    <div data-testid={testid} className="bg-raised p-[20px]">
      <div className="mb-[8px] font-mono text-[11px] text-ink-faint">{label}</div>
      <div className="font-mono text-[26px] font-bold">{children}</div>
    </div>
  );
}

/** One chart card: a color-dot title row over a per-resource BauhausChart. Renders an
 *  honest empty state (never a fabricated bar) when there are no resources to plot. */
function ChartCard({
  title,
  color,
  series,
  ariaLabel,
}: {
  title: string;
  color: TriadColor;
  series: ChartPoint[];
  ariaLabel: string;
}): React.ReactElement {
  const dot: Record<TriadColor, string> = {
    red: "var(--red)",
    blue: "var(--blue)",
    yellow: "var(--yellow)",
  };
  return (
    <div data-testid="chart-card" className="border border-hairline bg-raised p-[20px]">
      <div className="mb-[18px] flex items-center gap-[8px]">
        <span
          aria-hidden="true"
          className="h-[10px] w-[10px]"
          style={{ background: dot[color] }}
        />
        <span className="text-[14px] font-semibold">{title}</span>
      </div>
      {series.length === 0 ? (
        <div
          data-testid="chart-empty"
          className="flex h-[120px] items-center justify-center font-mono text-caption-mono text-ink-faint lowercase"
        >
          no resources yet
        </div>
      ) : (
        <BauhausChart series={series} color={color} ariaLabel={ariaLabel} />
      )}
    </div>
  );
}

export function RevenuePanel({
  earnings,
  totalCalls,
  liveApis,
  strikes,
  decimals,
  rows,
}: RevenuePanelProps): React.ReactElement {
  // Build the two chart series from REAL per-resource rows. The revenue bar height is the
  // proportional Number of the base-unit earnings (BauhausChart normalizes by the max, so
  // absolute scale is irrelevant and no decimal literal is applied); the calls bar is the
  // settled count. Empty rows -> empty series -> the ChartCard's honest empty state.
  const revenueSeries: ChartPoint[] = rows.map((r) => ({ label: r.slug, value: Number(r.revenue) }));
  const callsSeries: ChartPoint[] = rows.map((r) => ({ label: r.slug, value: r.calls }));
  return (
    <section data-testid="revenue-panel">
      {/* four stat cells in the seamless 1px hairline grid (the signature motif) */}
      <div className="mb-[16px] grid grid-cols-2 gap-px border border-hairline bg-hairline lg:grid-cols-4">
        <StatCell label="TOTAL EARNINGS" testid="stat-total-earnings">
          <UsdcAmount baseUnits={earnings} decimals={decimals} className="text-yellow" />
        </StatCell>
        <StatCell label="CALLS · 30D" testid="stat-calls-30d">
          <span className="text-blue">{formatCount(totalCalls)}</span>
        </StatCell>
        <StatCell label="LIVE APIS" testid="stat-live-apis">
          <span className="text-ink">{liveApis}</span>
        </StatCell>
        <StatCell label="STRIKES" testid="stat-strikes">
          <span className="text-ink">{strikes}</span>
        </StatCell>
      </div>

      {/* two chart cards: revenue=yellow, calls=blue (the color discipline). Both plot
          REAL per-resource data from the loader's rows. */}
      <div className="mb-[16px] grid grid-cols-1 gap-[16px] lg:grid-cols-2">
        <ChartCard
          title="revenue · usdc / resource"
          color="yellow"
          series={revenueSeries}
          ariaLabel="creator earnings per resource"
        />
        <ChartCard
          title="calls / resource"
          color="blue"
          series={callsSeries}
          ariaLabel="settled calls per resource"
        />
      </div>
    </section>
  );
}
