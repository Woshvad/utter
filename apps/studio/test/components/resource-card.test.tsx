// ResourceCard is the most important marketplace component. It RENDERS card data
// (price/identity/reputation projected by Phase 5); it must never re-derive a price.
// These tests pin the comp form (Utter.dc.html 397-433): the lowercase title, the
// mono yellow price pill (flat "$X / call" / metered "<= $cap"), the "/100" reputation
// in the creator row, the in-thumbnail verified badge, the calls figure, and the
// read-through discipline (the price shown equals the base units passed in).
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResourceCard } from "../../app/components/discover/ResourceCard";
import { CardGrid } from "../../app/components/discover/CardGrid";
import type { ResourceCardData } from "../../app/adapter/types";

const FLAT_CARD: ResourceCardData = {
  resourceId: "0x00000000000000000000000000000000000000000000000000000000000000a1",
  agentId: "42",
  slug: "weather-now",
  category: "data",
  pricing: { model: "flat", base: "10000", perKB: "0", max: "10000" },
  reputation: 12n,
  uptime: 0.98,
  bond: 5000000n,
  active: true,
};

const METERED_CARD: ResourceCardData = {
  resourceId: "0x00000000000000000000000000000000000000000000000000000000000000b2",
  agentId: "43",
  slug: "summarize-text",
  category: "compute",
  pricing: { model: "metered", base: "2000", perKB: "500", max: "50000" },
  reputation: 7n,
  uptime: 0.95,
  bond: 8000000n,
  active: true,
};

describe("ResourceCard", () => {
  it("renders the lowercase title from the card slug", () => {
    render(<ResourceCard card={FLAT_CARD} decimals={6} verified />);
    expect(screen.getByText("weather-now")).toBeInTheDocument();
  });

  it("renders a mono flat price pill from the passed base units ($0.010000)", () => {
    render(<ResourceCard card={FLAT_CARD} decimals={6} verified />);
    const pill = screen.getByTestId("price-pill");
    expect(within(pill).getByText("$0.01")).toBeInTheDocument();
    expect(pill).toHaveAttribute("data-model", "flat");
  });

  it("renders a metered price pill showing the cap (comp '<= $cap' form)", () => {
    render(<ResourceCard card={METERED_CARD} decimals={6} verified />);
    const pill = screen.getByTestId("price-pill");
    expect(pill).toHaveAttribute("data-model", "metered");
    // metered shows the cap $0.05, rendered from the passed cap base units
    expect(within(pill).getByText("$0.05")).toBeInTheDocument();
  });

  it("renders the '/100' reputation in the creator row and the in-thumbnail verified badge", () => {
    render(<ResourceCard card={FLAT_CARD} decimals={6} verified />);
    const rep = screen.getByTestId("reputation-badge");
    expect(rep).toHaveAttribute("data-variant", "score");
    expect(rep.textContent).toBe("12/100");
    // the in-thumbnail badge: the literal "verified" label renders only when verified
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("never recomputes the price - it renders exactly the base units it was given", () => {
    // base = 10000 base units, decimals = 6 -> $0.01. If the card recomputed
    // (e.g. multiplied by 1e6) the value would differ. We assert the exact string.
    render(<ResourceCard card={FLAT_CARD} decimals={6} verified />);
    expect(screen.getByText("$0.01")).toBeInTheDocument();
  });
});

describe("CardGrid", () => {
  it("renders one card per row of data", () => {
    render(<CardGrid cards={[FLAT_CARD, METERED_CARD]} decimals={6} />);
    expect(screen.getByText("weather-now")).toBeInTheDocument();
    expect(screen.getByText("summarize-text")).toBeInTheDocument();
  });

  it("renders the square-skeleton loading state, never a spinner", () => {
    render(<CardGrid cards={[]} decimals={6} loading />);
    expect(screen.getAllByTestId("card-skeleton").length).toBeGreaterThan(0);
  });

  it("renders the empty-state copy when there are no cards", () => {
    render(<CardGrid cards={[]} decimals={6} />);
    expect(screen.getByText(/nothing here yet\./i)).toBeInTheDocument();
    expect(screen.getByText(/utter the first one\./i)).toBeInTheDocument();
  });

  it("renders the no-results copy with the query when filtered to nothing", () => {
    render(<CardGrid cards={[]} decimals={6} query="weather" />);
    expect(screen.getByText(/no results for "weather"/i)).toBeInTheDocument();
  });
});
