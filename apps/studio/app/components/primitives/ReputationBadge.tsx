// ReputationBadge - the ERC-8004 reputation signal (feedbackCount). Two variants:
//
//   "meter" (default) - a geometric meter (filled/empty squares) + a mono numeric,
//     legible without color (shape + number). Used by the profile/channel header.
//   "score" - the marketplace card's compact "{n}/100" mono text (no meter), the
//     comp's "96/100" creator-row form.
//
// Reputation is an integer count (not money) so it is plain mono digits, never a USDC
// amount. This component RENDERS the projected reputation; it never recomputes it.
import * as React from "react";

export interface ReputationBadgeProps {
  /** feedbackCount from ERC-8004 readReputation (a plain count, NOT money). */
  feedbackCount: bigint;
  /** How many meter steps to draw (default 5). Meter variant only. */
  steps?: number;
  /** "meter" (default) draws the square meter; "score" renders "{n}/100" text. */
  variant?: "meter" | "score";
  className?: string;
}

export function ReputationBadge({
  feedbackCount,
  steps = 5,
  variant = "meter",
  className,
}: ReputationBadgeProps): React.ReactElement {
  if (variant === "score") {
    // The comp's compact creator-row form: "{n}/100" in faint mono. The projected
    // reputation value is shown as-is over 100 (never recomputed).
    const n = feedbackCount < 0n ? 0n : feedbackCount;
    return (
      <span
        data-testid="reputation-badge"
        data-variant="score"
        data-feedback={feedbackCount.toString()}
        className={[
          "font-mono text-[11px] text-ink-faint tabular-nums",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {`${n.toString()}/100`}
      </span>
    );
  }

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
      data-variant="meter"
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
