// MarketplaceStrip - the "top on the marketplace" strip on the landing page. Reuses
// the existing discover ResourceCard so every price renders ONLY through the
// PricePill -> UsdcAmount money surface (no money literal here, T-v7q-01). The cards
// are fed by the loader (adapter.listMarketplace read-through, T-v7q-02); this
// component never recomputes a price, identity, or bond.
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
    <section data-testid="landing-marketplace" className="mx-auto max-w-6xl px-xl py-xl">
      <div className="mb-lg flex items-baseline justify-between">
        <h2 className="text-display font-display font-semibold tracking-tight text-ink lowercase">
          top on the marketplace
        </h2>
        <Link to="/discover" className="font-mono text-caption-mono text-blue lowercase">
          see all -&gt;
        </Link>
      </div>

      {cards.length === 0 ? (
        <p className="text-body text-ink-muted lowercase">nothing listed yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => (
            <ResourceCard
              key={card.resourceId}
              card={card}
              decimals={decimals}
              href={`/resources/${card.resourceId}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
