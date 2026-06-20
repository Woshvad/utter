// BauhausChart - hand-rolled flat-triad SVG bar chart for the creator dashboard.
// Deliberately hand-rolled (recharts fights the brief): flat bars in ONE triad
// color, thick axes, mono labels, no gradient / 3D / glow. Parameterized by a data
// series + a triad color (revenue=yellow, calls=blue, health=red).
//
// NOTE: this chart plots plain numeric series (call counts, scores). When a money
// series is plotted, the caller scales base units to a display number via the same
// runtime-decimals path UsdcAmount uses BEFORE handing values here - this component
// carries no money-scale literal.
import * as React from "react";

export interface ChartPoint {
  label: string;
  value: number;
}

export type TriadColor = "red" | "blue" | "yellow";

export interface BauhausChartProps {
  series: ChartPoint[];
  color: TriadColor;
  /** Accessible chart label (required - the SVG is decorative without it). */
  ariaLabel: string;
  width?: number;
  height?: number;
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
  width = 320,
  height = 160,
  className,
}: BauhausChartProps): React.ReactElement {
  const pad = { top: 8, right: 8, bottom: 24, left: 8 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = series.reduce((m, p) => (p.value > m ? p.value : m), 0);
  const n = series.length;
  const gap = 8;
  const barW = n > 0 ? Math.max(2, (plotW - gap * (n - 1)) / n) : 0;
  const fill = COLOR_VAR[color];

  return (
    <div
      data-testid="bauhaus-chart"
      data-color={color}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {/* thick axes (hard rules) */}
        <line
          x1={pad.left}
          y1={pad.top + plotH}
          x2={pad.left + plotW}
          y2={pad.top + plotH}
          stroke="var(--hairline)"
          strokeWidth={2}
        />
        {series.map((p, i) => {
          const h = max > 0 ? (p.value / max) * plotH : 0;
          const x = pad.left + i * (barW + gap);
          const y = pad.top + plotH - h;
          return (
            <g key={`${p.label}-${i}`}>
              <rect
                data-testid="chart-bar"
                x={x}
                y={y}
                width={barW}
                height={h}
                fill={fill}
              />
              <text
                x={x + barW / 2}
                y={height - 8}
                textAnchor="middle"
                fill="var(--ink-faint)"
                fontFamily="var(--font-mono)"
                fontSize={10}
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
