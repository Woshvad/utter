// CardGrid - the responsive marketplace grid (16px gap) with the four states from
// the copywriting contract: data, loading (SQUARE skeletons, never a spinner),
// empty ("nothing here yet. utter the first one."), and no-results (with the query).
import * as React from "react";
import type { ResourceCardData } from "../../adapter/types";
import { ResourceCard } from "./ResourceCard";

export interface CardGridProps {
  cards: ResourceCardData[];
  decimals: number;
  /** When true, render square skeletons instead of cards. */
  loading?: boolean;
  /** The active search query - drives the no-results vs empty copy. */
  query?: string;
  /** Map resourceId -> verified flag (projected separately from the card). */
  verifiedById?: Record<string, boolean>;
  /** Build an href for a card (optional). */
  hrefFor?: (card: ResourceCardData) => string;
  /** How many skeletons to show while loading. */
  skeletonCount?: number;
}

function Skeletons({ count }: { count: number }): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          data-testid="card-skeleton"
          className="border border-hairline bg-raised"
          aria-hidden="true"
        >
          <div className="aspect-[16/9] w-full bg-g1" />
          <div className="flex flex-col gap-sm p-md">
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
  hrefFor,
  skeletonCount = 6,
}: CardGridProps): React.ReactElement {
  if (loading) {
    return <Skeletons count={skeletonCount} />;
  }

  if (cards.length === 0) {
    const hasQuery = Boolean(query && query.length > 0);
    return (
      <div
        data-testid="card-grid-empty"
        className="flex flex-col items-start gap-md border border-hairline bg-raised p-2xl"
      >
        {/* constructivist art block + one terse line */}
        <div aria-hidden="true" className="flex items-center gap-sm">
          <span className="inline-block rounded-full" style={{ width: 20, height: 20, background: "var(--red)" }} />
          <span className="inline-block" style={{ width: 20, height: 20, background: "var(--blue)" }} />
          <span
            style={{
              width: 0,
              height: 0,
              borderLeft: "11px solid transparent",
              borderRight: "11px solid transparent",
              borderBottom: "20px solid var(--yellow)",
            }}
          />
        </div>
        {hasQuery ? (
          <p className="text-body text-ink-muted lowercase">
            {`no results for "${query}". try a different term or clear filters.`}
          </p>
        ) : (
          <p className="text-body text-ink-muted lowercase">
            nothing here yet. utter the first one.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <ResourceCard
          key={card.resourceId}
          card={card}
          decimals={decimals}
          verified={verifiedById?.[card.resourceId]}
          href={hrefFor?.(card)}
        />
      ))}
    </div>
  );
}
