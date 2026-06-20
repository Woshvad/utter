// Input - hard-edged text field (1px box on raised, no radius) with a visible 2px
// triad focus ring (brief a11y rule). Mono variant for money/address fields. Pure
// presentational wrapper over a native <input> so labels/ARIA pass straight through.
import * as React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Use the mono family (money / address / hash fields). */
  mono?: boolean;
  /** Ink-underline variant instead of the full 1px box. */
  underline?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, underline, className, ...rest },
  ref,
) {
  const base = [
    "block w-full bg-raised text-ink placeholder:text-ink-faint",
    "px-sm py-sm text-body",
    "outline-none",
    // visible 2px triad focus ring (blue), the a11y requirement
    "focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-0",
    mono ? "font-mono tabular-nums" : "font-display",
    underline
      ? "border-0 border-b border-hairline focus-visible:border-blue"
      : "border border-hairline",
  ];
  return (
    <input
      ref={ref}
      className={[...base, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
});
