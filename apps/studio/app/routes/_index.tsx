// _index.tsx - the Utter front door at `/`. A full-bleed marketing screen (NOT the
// AppShell sidebar; the design's landing section is its own full-bleed layout with a
// slim top bar). It composes the three landing sections: the hero (wordmark + tagline +
// dual CTAs), the inverted paper how-it-works block, and the top-marketplace strip.
//
// Read-through discipline (T-v7q-02): the loader lists the top marketplace cards THROUGH
// the adapter (selectAdapter(process.env).listMarketplace({})), the same seam discover.tsx
// uses, and reads decimals from a RUNTIME getEscrowBalance().decimals read - no 1e6/6
// literal in this file's money path. The strip renders the projected cards straight
// through ResourceCard; it never recomputes a price.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import { tryGetRevenue } from "../adapter/revenue.js";
import type { ResourceCardData } from "../adapter/types.js";
import { Hero, HowItWorks, MarketplaceStrip } from "../components/landing/index.js";

/** The serialized loader payload the landing screen renders. */
export interface LandingData {
  /** The top marketplace cards (read-through; at most four). */
  cards: ResourceCardData[];
  /** Decimals from a runtime read (passed straight to the money renders). */
  decimals: number;
  /** Real per-card settled-calls counts, sourced from the adapter getRevenue (keyed by
   *  resourceId). Honest adapter-sourced figures, never hash-derived. */
  callsById: Record<string, number>;
}

/**
 * List the top marketplace cards through the adapter (read-through) and read decimals at
 * runtime. The strip shows the top four; the autonomous path returns deterministic
 * fixture cards so the strip always has real data to render.
 */
export async function loader({ request: _request }: LoaderFunctionArgs): Promise<LandingData> {
  const adapter = selectAdapter(process.env);

  // Runtime money scale (no 6/1e6 literal): read decimals once through the adapter.
  const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
  const { decimals } = await adapter.getEscrowBalance(zeroAddress);

  // Read THROUGH the adapter (unfiltered top-list), then take the top four for the strip.
  const all = await adapter.listMarketplace({});
  const cards = all.slice(0, 4);

  // Real calls per card, sourced THROUGH the display-only tryGetRevenue wrapper. A failed
  // (live-mode) facilitator read yields null for that card, which is OMITTED from
  // callsById so the strip shows no figure for it rather than crashing or inventing one.
  // The fixture success path never throws, so callsById is identical to before.
  const callsEntries = await Promise.all(
    cards.map(async (card) => {
      const revenue = await tryGetRevenue(adapter, card.resourceId);
      return [card.resourceId, revenue ? revenue.calls : null] as const;
    }),
  );
  const callsById: Record<string, number> = Object.fromEntries(
    callsEntries.filter(([, c]) => c !== null) as [string, number][],
  );

  return { cards, decimals, callsById };
}

/** The slim marketing top bar (wordmark left; discover / connect / +utter links right).
 *  72px tall with a hairline base rule, matching the comp header (Utter.dc.html 71-82). */
function TopBar(): React.ReactElement {
  return (
    <header className="flex h-[72px] items-center justify-between border-b border-hairline">
      <div className="flex items-center gap-[10px]">
        <span
          aria-hidden="true"
          className="inline-block rounded-full"
          style={{ width: 16, height: 16, background: "var(--red)" }}
        />
        <span
          aria-hidden="true"
          style={{
            width: 0,
            height: 0,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            borderLeft: "9px solid var(--ink)",
          }}
        />
        <span className="text-[18px] font-display font-bold tracking-[-0.03em] text-ink lowercase">
          utter
        </span>
      </div>
      <nav
        aria-label="marketing"
        className="flex items-center gap-[6px] font-mono text-[13px] lg:gap-[8px]"
      >
        {/* discover is reachable from the hero's "browse marketplace" CTA; hide it on
            mobile so the wordmark + connect + utter fit a phone row without wrapping. */}
        <Link
          to="/discover"
          className="hidden whitespace-nowrap px-[14px] py-[10px] text-ink-muted lowercase sm:block"
        >
          discover
        </Link>
        <Link
          to="/auth"
          className="whitespace-nowrap border border-hairline px-[12px] py-[10px] text-ink lowercase lg:px-[16px]"
        >
          connect wallet
        </Link>
        {/* +utter: white text on red (the comp fix - it was near-black/text-canvas). */}
        <Link
          to="/create"
          className="whitespace-nowrap px-[14px] py-[10px] font-semibold text-white lowercase lg:px-[18px]"
          style={{ background: "var(--red)" }}
        >
          + utter
        </Link>
      </nav>
    </header>
  );
}

export default function LandingRoute(): React.ReactElement {
  const { cards, decimals, callsById } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto max-w-[1320px] px-[16px] lg:px-[32px]">
        <TopBar />
        <Hero />
      </div>
      <HowItWorks />
      <MarketplaceStrip cards={cards} decimals={decimals} callsById={callsById} />
    </div>
  );
}
