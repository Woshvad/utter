// CategoryChips - the square category filter chips for the Discover browse screen.
//
// Each chip maps 1:1 to FilterCriteria.category (an absent/`all` chip clears it). The
// active chip carries the triad accent (square fill, never a pill/rounded glow) per
// the UI-SPEC color discipline; status is shape + color, never color alone (the active
// chip also carries aria-pressed + a filled marker).
//
// These are plain links so the loader (a GET) re-reads the criteria from the URL query
// string - the read-through browse model. No money/identity is derived here.
import * as React from "react";

export interface CategoryChipsProps {
  /** The categories present in the index (deduped, from the loader). */
  categories: string[];
  /** The currently-selected category, or undefined for "all". */
  active?: string;
  /** Build the href for a chip (preserves the other query params). */
  hrefFor: (category: string | undefined) => string;
}

export function CategoryChips({
  categories,
  active,
  hrefFor,
}: CategoryChipsProps): React.ReactElement {
  const chips: Array<{ label: string; value: string | undefined }> = [
    { label: "all", value: undefined },
    ...categories.map((c) => ({ label: c, value: c })),
  ];

  return (
    <div
      data-testid="category-chips"
      role="group"
      aria-label="filter by category"
      className="flex flex-wrap items-center gap-xs"
    >
      {chips.map((chip) => {
        const isActive = (chip.value ?? undefined) === (active ?? undefined);
        return (
          <a
            key={chip.label}
            href={hrefFor(chip.value)}
            aria-pressed={isActive}
            data-active={isActive}
            className={[
              "inline-flex min-h-[44px] items-center gap-2xs border px-sm py-2xs font-mono text-caption-mono lowercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue",
              isActive
                ? "border-blue bg-blue text-paper"
                : "border-hairline bg-raised text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {/* shape marker so the active state is not color-only (a11y) */}
            <span
              aria-hidden="true"
              className={isActive ? "inline-block h-2 w-2 bg-paper" : "inline-block h-2 w-2 border border-hairline"}
            />
            {chip.label}
          </a>
        );
      })}
    </div>
  );
}
