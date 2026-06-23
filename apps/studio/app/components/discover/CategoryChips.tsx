// CategoryChips - the category filter chips for the Discover browse screen.
//
// Each chip maps 1:1 to FilterCriteria.category (an absent/`all` chip clears it). The
// active chip is a neutral ink-filled block (the comp's #ECEAE3 fill with black text -
// NOT a triad hue); the inactive chip is a hairline outline. Status carries
// aria-pressed + data-active so meaning is not color-only.
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
      className="flex flex-wrap gap-[8px]"
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
              "inline-flex items-center whitespace-nowrap border px-[15px] py-[8px] font-mono text-[13px] lowercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue",
              isActive
                ? "border-ink bg-ink text-canvas"
                : "border-hairline bg-transparent text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {chip.label}
          </a>
        );
      })}
    </div>
  );
}
