// SortControl - the discover sort order (top / new / cheapest / most-reputable).
//
// Sort is a pure ordering over the read-through cards; it NEVER recomputes a price or
// reputation - it orders by the projected values (pricing.base bigint, reputation
// bigint, uptime number). Rendered as plain links so the loader applies the order from
// the ?sort= query param (the read-through browse model).
import * as React from "react";
import type { ResourceCardData } from "../../adapter/types";

/** The four sort orders the discover screen offers. */
export type SortOrder = "top" | "new" | "cheapest" | "most-reputable";

/** The ordered sort options + their labels. */
export const SORT_OPTIONS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: "top", label: "top" },
  { value: "new", label: "new" },
  { value: "cheapest", label: "cheapest" },
  { value: "most-reputable", label: "most reputable" },
] as const;

/** Narrow an arbitrary string to a SortOrder, defaulting to "top". */
export function parseSort(value: string | null | undefined): SortOrder {
  switch (value) {
    case "new":
    case "cheapest":
    case "most-reputable":
      return value;
    default:
      return "top";
  }
}

/**
 * Order the projected cards by the chosen sort, PURELY (a new array; never mutates the
 * input and never recomputes money). Cheapest reads pricing.base as bigint; most-
 * reputable reads the projected reputation; top/new fall back to the index order with
 * uptime as the tiebreak (a stable, deterministic ordering).
 */
export function sortCards(cards: ResourceCardData[], sort: SortOrder): ResourceCardData[] {
  const copy = [...cards];
  switch (sort) {
    case "cheapest":
      return copy.sort((a, b) => {
        const pa = BigInt(a.pricing.base);
        const pb = BigInt(b.pricing.base);
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    case "most-reputable":
      return copy.sort((a, b) => (a.reputation < b.reputation ? 1 : a.reputation > b.reputation ? -1 : 0));
    case "new":
      // No timestamp on the projection; "new" is the reverse index order (newest last
      // appended), a deterministic stand-in until a mint timestamp lands on the card.
      return copy.reverse();
    case "top":
    default:
      return copy.sort((a, b) => b.uptime - a.uptime);
  }
}

export interface SortControlProps {
  active: SortOrder;
  /** Build the href for a sort option (preserves the other query params). */
  hrefFor: (sort: SortOrder) => string;
}

export function SortControl({ active, hrefFor }: SortControlProps): React.ReactElement {
  return (
    <div
      data-testid="sort-control"
      role="group"
      aria-label="sort results"
      className="flex items-center gap-2xs"
    >
      <span className="font-display text-label text-ink-faint lowercase">sort</span>
      {SORT_OPTIONS.map((opt) => {
        const isActive = opt.value === active;
        return (
          <a
            key={opt.value}
            href={hrefFor(opt.value)}
            aria-pressed={isActive}
            data-active={isActive}
            className={[
              "inline-flex min-h-[44px] items-center border-b-2 px-2xs font-mono text-caption-mono lowercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue",
              isActive ? "border-blue text-ink" : "border-transparent text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {opt.label}
          </a>
        );
      })}
    </div>
  );
}
