// VerifiedBadge - the "this endpoint passed verification" signal. Legible without
// color: it carries a circle glyph (verified = a complete, live identity) + the
// literal "verified" / "unverified" text, so meaning is shape + label. Blue is the
// identity/verified accent; an unverified resource renders a hollow neutral glyph.
//
// Sized to the comp's small form (7px blue circle + mono 10px ink-muted "verified");
// the in-thumbnail boxed variant on the marketplace card composes this glyph inside
// its own canvas/hairline chip (see ResourceCard). The standalone badge is reused on
// the detail reputation row.
import * as React from "react";

export interface VerifiedBadgeProps {
  verified: boolean;
  className?: string;
}

export function VerifiedBadge({ verified, className }: VerifiedBadgeProps): React.ReactElement {
  return (
    <span
      data-testid="verified-badge"
      data-verified={verified}
      className={[
        "inline-flex items-center gap-[6px]",
        "font-mono text-[10px]",
        verified ? "text-ink-muted" : "text-ink-faint",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* circle = identity / verified-complete */}
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{
          width: 7,
          height: 7,
          background: verified ? "var(--blue)" : "transparent",
          border: verified ? "none" : "1px solid var(--ink-faint)",
        }}
      />
      <span className="lowercase">{verified ? "verified" : "unverified"}</span>
    </span>
  );
}
