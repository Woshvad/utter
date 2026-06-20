// StatusDot - the Bauhaus status motif. Meaning is ALWAYS triad-color PLUS shape
// (brief §13 / WCAG): a colorblind or screen-reader user reads the state from the
// shape + label, never the hue alone.
//
//   circle   = live / identity            (red when live, blue when identity)
//   square   = resource / block / verifying
//   triangle = action / run / failed
//
// The shape is emitted as a `data-shape` attr (and a visible SVG/box) and the color
// as `data-color`, plus an SR-only text label, so the state is fully non-visual.
import * as React from "react";

export type StatusState =
  | "live"
  | "building"
  | "verifying"
  | "paused"
  | "failed"
  | "idle";

type Shape = "circle" | "square" | "triangle";
type TriadColor = "red" | "blue" | "yellow" | "neutral";

interface StateSpec {
  shape: Shape;
  color: TriadColor;
  label: string;
  pulse?: boolean;
}

// The single mapping table from state -> { shape, color, label }.
const STATE_SPEC: Record<StatusState, StateSpec> = {
  live: { shape: "circle", color: "red", label: "live" },
  building: { shape: "square", color: "blue", label: "building", pulse: true },
  verifying: { shape: "square", color: "blue", label: "verifying", pulse: true },
  paused: { shape: "square", color: "yellow", label: "paused" },
  failed: { shape: "triangle", color: "red", label: "failed" },
  idle: { shape: "square", color: "neutral", label: "idle" },
};

const COLOR_VAR: Record<TriadColor, string> = {
  red: "var(--red)",
  blue: "var(--blue)",
  yellow: "var(--yellow)",
  neutral: "var(--ink-faint)",
};

export interface StatusDotProps {
  state: StatusState;
  /** Pixel size of the glyph (hit target is padded separately by the caller). */
  size?: number;
  /** Show the text label beside the glyph (default true; keeps meaning non-visual). */
  showLabel?: boolean;
  className?: string;
}

function ShapeGlyph({
  shape,
  color,
  size,
  pulse,
}: {
  shape: Shape;
  color: string;
  size: number;
  pulse?: boolean;
}): React.ReactElement {
  const anim = pulse ? "animate-utter-pulse" : undefined;
  if (shape === "circle") {
    return (
      <span
        aria-hidden="true"
        className={["inline-block", "rounded-full", anim].filter(Boolean).join(" ")}
        style={{ width: size, height: size, background: color }}
      />
    );
  }
  if (shape === "square") {
    return (
      <span
        aria-hidden="true"
        className={["inline-block", anim].filter(Boolean).join(" ")}
        style={{ width: size, height: size, background: color }}
      />
    );
  }
  // triangle (upward), built from borders so it stays a hard geometric glyph
  return (
    <span
      aria-hidden="true"
      className={["inline-block", anim].filter(Boolean).join(" ")}
      style={{
        width: 0,
        height: 0,
        borderLeft: `${size / 2}px solid transparent`,
        borderRight: `${size / 2}px solid transparent`,
        borderBottom: `${size}px solid ${color}`,
      }}
    />
  );
}

export function StatusDot({
  state,
  size = 10,
  showLabel = true,
  className,
}: StatusDotProps): React.ReactElement {
  const spec = STATE_SPEC[state];
  const color = COLOR_VAR[spec.color];
  return (
    <span
      data-testid="status-dot"
      data-shape={spec.shape}
      data-color={spec.color}
      data-state={state}
      role="status"
      className={["inline-flex", "items-center", "gap-xs", className]
        .filter(Boolean)
        .join(" ")}
    >
      <ShapeGlyph shape={spec.shape} color={color} size={size} pulse={spec.pulse} />
      {showLabel ? (
        <span className="text-caption-mono font-mono text-ink-muted lowercase">
          {spec.label}
        </span>
      ) : (
        <span className="sr-only">{spec.label}</span>
      )}
    </span>
  );
}
