// BauhausChart - hand-rolled flat-triad bar chart for the creator dashboard.
// Deliberately hand-rolled (recharts fights the brief): flat bars in ONE triad
// color, thick axes, no gradient / 3D / glow. Parameterized by a numeric series + a
// triad color (revenue=yellow, calls=blue, health=red).
//
// Comp (Design/Utter.dc.html 653-655): a 140px plot with BOTH a left and a bottom
// 2px hairline axis; bars flex-end, gap 6px, each flex-1, height as a percent of the
// series max. The comp has NO per-bar x-axis text labels, so this chart draws none.
//
// NOTE: this chart plots plain numeric series (call counts, scaled money). When a
// money series is plotted, the caller scales base units to a display number via the
// same runtime-decimals path UsdcAmount uses BEFORE handing values here - this
// component carries no money-scale literal.
import * as React from "react";

export interface ChartPoint {
  label: string;
  value: number;
}

export type TriadColor = "red" | "blue" | "yellow";

export interface BauhausChartProps {
  /** The numeric series (already display-scaled for money). */
  series: ChartPoint[];
  /** The triad fill color for the bars. */
  color: TriadColor;
  /** Accessible chart label (required - the bars are decorative without it). */
  ariaLabel: string;
  className?: string;
}

const COLOR_VAR: Record<TriadColor, string> = {
  red: "var(--red)",
  blue: "var(--blue)",
  yellow: "var(--yellow)",
};

export function BauhausChart({
  series,
  color,
  ariaLabel,
  className,
}: BauhausChartProps): React.ReactElement {
  const max = series.reduce((m, p) => (p.value > m ? p.value : m), 0);
  const fill = COLOR_VAR[color];

  return (
    <div
      data-testid="bauhaus-chart"
      data-color={color}
      className={
        ["flex h-[140px] items-end gap-[6px] border-b-2 border-l-2 border-hairline pl-[8px]", className]
          .filter(Boolean)
          .join(" ")
      }
      role="img"
      aria-label={ariaLabel}
    >
      {series.map((p, i) => {
        // Height as a percent of the series max (the comp's bar scaling).
        const pct = max > 0 ? (p.value / max) * 100 : 0;
        return (
          <div
            key={`${p.label}-${i}`}
            data-testid="chart-bar"
            data-value={p.value}
            className="flex-1"
            style={{ height: `${pct}%`, background: fill }}
          />
        );
      })}
    </div>
  );
}
