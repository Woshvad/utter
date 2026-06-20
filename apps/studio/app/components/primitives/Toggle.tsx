// Toggle - a hard-edged switch with a SQUARE knob (no rounded pill). Used for the
// composer pricing flat/metered toggle. Implemented as a native button with the
// `switch` role + aria-checked so it is fully keyboard / SR operable, and carries
// the 2px triad focus ring.
import * as React from "react";

export interface ToggleProps {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  /** Accessible label (also rendered as visible text when `showLabel`). */
  label: string;
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  pressed,
  onPressedChange,
  label,
  showLabel = true,
  disabled,
  className,
}: ToggleProps): React.ReactElement {
  return (
    <span className={["inline-flex items-center gap-xs", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        role="switch"
        aria-checked={pressed}
        aria-label={label}
        disabled={disabled}
        onClick={() => onPressedChange(!pressed)}
        data-testid="toggle"
        data-pressed={pressed}
        className={[
          "relative inline-flex items-center",
          "h-5 w-9 border border-hairline",
          pressed ? "bg-blue" : "bg-raised",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
          "outline-none focus-visible:ring-2 focus-visible:ring-blue",
        ].join(" ")}
      >
        {/* square knob, snaps left/right - no rounded pill */}
        <span
          aria-hidden="true"
          className="absolute top-0.5 h-3.5 w-3.5 bg-ink transition-[left] duration-150"
          style={{ left: pressed ? "calc(100% - 1rem)" : "0.125rem" }}
        />
      </button>
      {showLabel ? (
        <span className="text-label font-display text-ink lowercase">{label}</span>
      ) : null}
    </span>
  );
}
