// ReputationBadge - the ERC-8004 reputation signal (feedbackCount), rendered as a
// geometric meter + a mono numeric, legible at a glance on every card. Reputation
// is an integer count (not money) so it is plain mono digits, not a USDC amount.
// Legible without color: the meter is a row of filled/empty squares (shape) and the
// count is printed, so meaning is shape + number, never hue alone.
import * as React from "react";

export interface ReputationBadgeProps {
  /** feedbackCount from ERC-8004 readReputation (a plain count, NOT money). */
  feedbackCount: bigint;
  /** How many meter steps to draw (default 5). */
  steps?: number;
  className?: string;
}

export function ReputationBadge({
  feedbackCount,
  steps = 5,
  className,
}: ReputationBadgeProps): React.ReactElement {
  // A simple log-ish fill: every ~5 feedbacks lights one more step, capped at `steps`.
  const lit = (() => {
    const n = feedbackCount < 0n ? 0n : feedbackCount;
    let filled = 0;
    let threshold = 1n;
    for (let i = 0; i < steps; i += 1) {
      if (n >= threshold) filled = i + 1;
      threshold *= 5n;
    }
    return filled;
  })();

  return (
    <span
      data-testid="reputation-badge"
      data-feedback={feedbackCount.toString()}
      className={[
        "inline-flex items-center gap-2xs",
        "font-mono text-caption-mono text-ink-muted",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={`${feedbackCount.toString()} feedbacks`}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-[2px]">
        {Array.from({ length: steps }).map((_, i) => (
          <span
            key={i}
            className="inline-block"
            style={{
              width: 4,
              height: 8,
              background: i < lit ? "var(--blue)" : "var(--g2)",
            }}
          />
        ))}
      </span>
      <span className="tabular-nums">{feedbackCount.toString()}</span>
    </span>
  );
}
