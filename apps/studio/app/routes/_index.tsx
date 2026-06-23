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
import type { ResourceCardData } from "../adapter/types.js";
import { Hero, HowItWorks, MarketplaceStrip } from "../components/landing/index.js";

/** The serialized loader payload the landing screen renders. */
export interface LandingData {
  /** The top marketplace cards (read-through; at most four). */
  cards: ResourceCardData[];
  /** Decimals from a runtime read (passed straight to the money renders). */
  decimals: number;
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

  return { cards, decimals };
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
        className="flex items-center gap-[8px] font-mono text-[13px]"
      >
        <Link to="/discover" className="px-[14px] py-[10px] text-ink-muted lowercase">
          discover
        </Link>
        <Link
          to="/auth"
          className="border border-hairline px-[16px] py-[10px] text-ink lowercase"
        >
          connect wallet
        </Link>
        {/* +utter: white text on red (the comp fix - it was near-black/text-canvas). */}
        <Link
          to="/create"
          className="px-[18px] py-[10px] font-semibold text-white lowercase"
          style={{ background: "var(--red)" }}
        >
          + utter
        </Link>
      </nav>
    </header>
  );
}

export default function LandingRoute(): React.ReactElement {
  const { cards, decimals } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto max-w-[1320px] px-[32px]">
        <TopBar />
        <Hero />
      </div>
      <HowItWorks />
      <MarketplaceStrip cards={cards} decimals={decimals} />
    </div>
  );
}
