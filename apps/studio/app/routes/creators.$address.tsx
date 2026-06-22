// creators.$address.tsx - the PUBLIC creator "channel" profile page (/creators/:address).
//
// Layout: full-content, NO AppShell - this mirrors discover.tsx / _index.tsx, which render
// plain content inside a centered max-width container (mx-auto max-w-* flex-col gap-* p-*).
// The page is PUBLIC (no requireCreator); the creator-only gate is reserved for
// create/dashboard/wallet/keys.
//
// Data-sourcing seam (the one real constraint): ResourceCardData has NO `creator` field -
// only ResourceDetail (getResourceDetail) carries `creator: Hex`. So the loader lists every
// card THROUGH the adapter, then resolves each card's owner via getResourceDetail and keeps
// only the cards whose detail.creator matches the :address param. Totals are aggregated from
// what the adapter exposes (getRevenue .calls + .creatorShare, the projected creator
// earnings) - nothing on-chain is invented or recomputed (T-06-REDERIVE, T-vsi-03).
//
// Money discipline: the runtime decimals come from a read through the adapter
// (getEscrowBalance().decimals), never a 1e6/6 literal; total earnings render only through
// the single UsdcAmount surface inside ChannelHeader (T-vsi-02).
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import type { Hex, ResourceCardData } from "../adapter/types.js";
import { CardGrid } from "../components/discover/CardGrid.js";
import { ChannelHeader } from "../components/profile/ChannelHeader.js";

/**
 * A bounded, safe address param (decode-before-use, ASVS V5 / T-vsi-01): a 0x-prefixed
 * 40-hex-char address shape. A malformed value is NOT thrown on - the loader returns an
 * empty-creator payload so the screen renders an unknown address honestly.
 */
function isAddressParam(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Case-insensitive hex address compare (addresses may differ only by checksum casing). */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The serialized loader payload the screen renders. */
export interface CreatorProfileData {
  /** The :address param echoed back (the channel owner). */
  address: string;
  /** The creator's filtered cards (only those whose detail.creator matches address). */
  cards: ResourceCardData[];
  /** Runtime money scale (read through the adapter, never a literal). */
  decimals: number;
  /** How many live apis the creator has (the filtered cards length). */
  apiCount: number;
  /** Aggregated ERC-8004 feedbackCount across the creator's cards. */
  reputation: bigint;
  /** Total settled calls across the creator's apis. */
  totalCalls: number;
  /** Total creator earnings in base units (sum of getRevenue.creatorShare). */
  totalEarnings: bigint;
}

/** The empty-creator payload (unknown/bad address): zero totals, no cards, honest decimals. */
function emptyPayload(address: string, decimals: number): CreatorProfileData {
  return {
    address,
    cards: [],
    decimals,
    apiCount: 0,
    reputation: 0n,
    totalCalls: 0,
    totalEarnings: 0n,
  };
}

export async function loader({ params }: LoaderFunctionArgs): Promise<CreatorProfileData> {
  const adapter = selectAdapter(process.env);

  // Runtime money scale (no 6/1e6 literal): one decimals read through the adapter.
  const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
  const { decimals } = await adapter.getEscrowBalance(zeroAddress);

  const address = params.address ?? "";
  // A malformed address renders the page honestly (empty grid, zero totals), never a throw.
  if (!isAddressParam(address)) {
    return emptyPayload(address, decimals);
  }

  // List every card THROUGH the adapter, then resolve each card's owner via
  // getResourceDetail (the only carrier of `creator`) and keep matches for this address.
  const allCards = await adapter.listMarketplace({});
  const owned = await Promise.all(
    allCards.map(async (card) => {
      const detail = await adapter.getResourceDetail(card.resourceId);
      return sameAddress(detail.creator, address) ? card : undefined;
    }),
  );
  const cards = owned.filter((c): c is ResourceCardData => c !== undefined);

  // Aggregate totals from what the adapter exposes - nothing invented or recomputed.
  // reputation: sum of the filtered cards' projected feedbackCount.
  const reputation = cards.reduce((sum, c) => sum + c.reputation, 0n);

  // calls + earnings: read getRevenue per filtered card and sum .calls (count) and
  // .creatorShare (the projected creator earnings in base units; the split is not recomputed).
  const revenues = await Promise.all(cards.map((c) => adapter.getRevenue(c.resourceId)));
  const totalCalls = revenues.reduce((sum, r) => sum + r.calls, 0);
  const totalEarnings = revenues.reduce((sum, r) => sum + r.creatorShare, 0n);

  return {
    address,
    cards,
    decimals,
    apiCount: cards.length,
    reputation,
    totalCalls,
    totalEarnings,
  };
}

export default function CreatorProfileRoute(): React.ReactElement {
  const { address, cards, decimals, apiCount, reputation, totalCalls, totalEarnings } =
    useLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-lg p-xl">
      <header className="flex flex-col gap-xs">
        <span className="text-caption-mono font-mono text-ink-faint lowercase">channel</span>
        <h1 className="text-display font-display lowercase text-ink">creator</h1>
      </header>

      <ChannelHeader
        address={address}
        reputation={reputation}
        apiCount={apiCount}
        totalCalls={totalCalls}
        totalEarnings={totalEarnings}
        decimals={decimals}
      />

      <section className="flex flex-col gap-md">
        <h2 className="text-heading font-display lowercase text-ink">apis</h2>
        <CardGrid
          cards={cards}
          decimals={decimals}
          hrefFor={(card) => `/resources/${card.resourceId}`}
        />
      </section>
    </div>
  );
}
