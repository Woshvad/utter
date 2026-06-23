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
// leads yellow (money). The 12-month chart series have no real monthly history; they
// are the representative comp series, clearly representative.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { SampleBadge } from "../primitives/SampleBadge";
import { BauhausChart, type ChartPoint, type TriadColor } from "../charts/BauhausChart";

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
  /** Representative 12-point monthly revenue series (no real history). */
  revenueSeries: number[];
  /** Representative 12-point monthly calls series (no real history). */
  callsSeries: number[];
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

/** One chart card: a color-dot title row over a 12-bar BauhausChart. */
function ChartCard({
  title,
  color,
  values,
  ariaLabel,
}: {
  title: string;
  color: TriadColor;
  values: number[];
  ariaLabel: string;
}): React.ReactElement {
  const dot: Record<TriadColor, string> = {
    red: "var(--red)",
    blue: "var(--blue)",
    yellow: "var(--yellow)",
  };
  const series: ChartPoint[] = values.map((v, i) => ({ label: `m${i + 1}`, value: v }));
  return (
    <div data-testid="chart-card" className="border border-hairline bg-raised p-[20px]">
      <div className="mb-[18px] flex items-center gap-[8px]">
        <span
          aria-hidden="true"
          className="h-[10px] w-[10px]"
          style={{ background: dot[color] }}
        />
        <span className="text-[14px] font-semibold">{title}</span>
        {/* the 12-month series has no real history source - mark it as sample */}
        <SampleBadge className="ml-auto" />
      </div>
      <BauhausChart series={series} color={color} ariaLabel={ariaLabel} />
    </div>
  );
}

export function RevenuePanel({
  earnings,
  totalCalls,
  liveApis,
  strikes,
  decimals,
  revenueSeries,
  callsSeries,
}: RevenuePanelProps): React.ReactElement {
  return (
    <section data-testid="revenue-panel">
      {/* four stat cells in the seamless 1px hairline grid (the signature motif) */}
      <div className="mb-[16px] grid grid-cols-4 gap-px border border-hairline bg-hairline">
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

      {/* two chart cards: revenue=yellow, calls=blue (the color discipline) */}
      <div className="mb-[16px] grid grid-cols-2 gap-[16px]">
        <ChartCard
          title="revenue · usdc / month"
          color="yellow"
          values={revenueSeries}
          ariaLabel="monthly revenue in usdc (representative)"
        />
        <ChartCard
          title="calls / month"
          color="blue"
          values={callsSeries}
          ariaLabel="monthly calls (representative)"
        />
      </div>
    </section>
  );
}
