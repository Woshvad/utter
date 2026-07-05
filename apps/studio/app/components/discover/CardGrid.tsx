// CardGrid - the responsive marketplace grid (comp 395: auto-fill minmax(290px), 16px
// gap) with the four states: data, loading (hairline-block skeletons, never a spinner),
// empty ("nothing here yet." / "utter the first one."), and no-results (with the query).
import * as React from "react";
import type { ResourceCardData } from "../../adapter/types";
import { ResourceCard } from "./ResourceCard";

export interface CardGridProps {
  cards: ResourceCardData[];
  decimals: number;
  /** When true, render skeletons instead of cards. */
  loading?: boolean;
  /** The active search query - drives the no-results vs empty copy. */
  query?: string;
  /** Map resourceId -> verified flag (projected separately from the card). */
  verifiedById?: Record<string, boolean>;
  /** Map resourceId -> real adapter-sourced calls count. Cards without an entry render
   *  no calls figure (never a fabricated one). */
  callsById?: Record<string, number>;
  /** Build an href for a card (optional). */
  hrefFor?: (card: ResourceCardData) => string;
  /** How many skeletons to show while loading. */
  skeletonCount?: number;
  /** Thumbnail height in px forwarded to each card (default 150; profile uses 130). */
  thumbHeight?: number;
}

/** The auto-fill grid (comp 395). The min() clamps the track to the container so a
 *  narrow phone (< 290px content) never overflows horizontally. */
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-[16px]";

function Skeletons({ count }: { count: number }): React.ReactElement {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          data-testid="card-skeleton"
          className="border border-hairline bg-raised"
          aria-hidden="true"
        >
          <div className="h-[150px] w-full bg-canvas" />
          <div className="flex flex-col gap-[10px] p-[14px]">
            <div className="h-4 w-2/3 bg-g2" />
            <div className="h-3 w-1/2 bg-g1" />
            <div className="h-5 w-1/3 bg-g2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CardGrid({
  cards,
  decimals,
  loading,
  query,
  verifiedById,
  callsById,
  hrefFor,
  skeletonCount = 6,
  thumbHeight = 150,
}: CardGridProps): React.ReactElement {
  if (loading) {
    return <Skeletons count={skeletonCount} />;
  }

  if (cards.length === 0) {
    const hasQuery = Boolean(query && query.length > 0);
    return (
      <div data-testid="card-grid-empty" className="py-[80px] text-center">
        {/* three outline triad shapes (comp 385-389) */}
        <div aria-hidden="true" className="mb-[20px] inline-flex gap-[10px]">
          <span className="inline-block border-2 border-hairline" style={{ width: 20, height: 20 }} />
          <span
            className="inline-block rounded-full border-2 border-hairline"
            style={{ width: 20, height: 20 }}
          />
          <span
            style={{
              width: 0,
              height: 0,
              borderLeft: "11px solid transparent",
              borderRight: "11px solid transparent",
              borderBottom: "18px solid var(--hairline)",
            }}
          />
        </div>
        {hasQuery ? (
          <p className="text-[14px] text-ink-muted lowercase">
            {`no results for "${query}". try a different term or clear filters.`}
          </p>
        ) : (
          <>
            <div className="mb-[6px] text-[18px] font-semibold lowercase text-ink">
              nothing here yet.
            </div>
            <div className="text-[14px] text-ink-muted lowercase">utter the first one.</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={GRID_CLASS}>
      {cards.map((card) => (
        <ResourceCard
          key={card.resourceId}
          card={card}
          decimals={decimals}
          verified={verifiedById?.[card.resourceId]}
          calls={callsById?.[card.resourceId]}
          href={hrefFor?.(card)}
          thumbHeight={thumbHeight}
        />
      ))}
    </div>
  );
}
