// SampleBadge - a tiny on-brand "sample data" chip for panels that have no live data
// source wired yet (the wallet tx-history / spend-caps, the dashboard charts, the mcp
// recent-paid-calls feed + spend-cap meter). It marks representative data clearly so
// nothing reads as live when it is not. It carries NO money and no real metric; it is
// purely a label. The style matches the existing section-label ink (mono-uppercase,
// ~10px, tracking .06em, ink-faint) so it stays subtle and pixel-consistent.
import * as React from "react";

export interface SampleBadgeProps {
  /** The chip label (default "sample data"). */
  label?: string;
  className?: string;
}

export function SampleBadge({
  label = "sample data",
  className,
}: SampleBadgeProps): React.ReactElement {
  return (
    <span
      data-testid="sample-badge"
      className={[
        "inline-flex items-center border border-hairline px-[6px] py-[2px]",
        "font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label}
    </span>
  );
}
