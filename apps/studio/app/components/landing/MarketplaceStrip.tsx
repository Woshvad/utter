// MarketplaceStrip - the "top on the marketplace" strip on the landing page (comp
// 141-161). Reuses the discover ResourceCard in its `compact` form (120px thumbnail +
// 14px title + yellow price only) so every price still renders ONLY through the
// PricePill -> UsdcAmount money surface (no money literal here, T-v7q-01). The cards are
// fed by the loader (adapter.listMarketplace read-through, T-v7q-02); this component
// never recomputes a price, identity, or bond.
import * as React from "react";
import { Link } from "react-router";
import type { ResourceCardData } from "../../adapter/types";
import { ResourceCard } from "../discover/ResourceCard";

export interface MarketplaceStripProps {
  /** The top marketplace cards (projected by the loader; rendered straight through). */
  cards: ResourceCardData[];
  /** Decimals from a runtime read, passed through to the money renders. */
  decimals: number;
}

export function MarketplaceStrip({ cards, decimals }: MarketplaceStripProps): React.ReactElement {
  return (
    <section
      data-testid="landing-marketplace"
      className="mx-auto max-w-[1320px] px-[32px] pt-[56px] pb-[80px]"
    >
      <div className="mb-[24px] flex items-baseline justify-between">
        <h2 className="text-[28px] font-display font-semibold tracking-[-0.02em] text-ink lowercase">
          top on the marketplace
        </h2>
        <Link to="/discover" className="font-mono text-[13px] text-blue lowercase">
          see all →
        </Link>
      </div>

      {cards.length === 0 ? (
        <p className="text-body text-ink-muted lowercase">nothing listed yet.</p>
      ) : (
        <div className="grid grid-cols-4 gap-[16px]">
          {cards.map((card) => (
            <ResourceCard
              key={card.resourceId}
              card={card}
              decimals={decimals}
              thumbHeight={120}
              compact
              href={`/resources/${card.resourceId}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
