// creator-profile.test.tsx - the /creators/:address channel profile loader + screen.
//
// Covers: (1) the loader filters cards by creator by resolving each card's owner THROUGH
// getResourceDetail (since ResourceCardData has no `creator` field) and aggregates
// apiCount/reputation/calls/earnings from the adapter - nothing recomputed or invented
// (T-06-REDERIVE, T-vsi-03); (2) the getResourceDetail seam is spy-asserted (the creator
// association is resolved through the seam); (3) unknown + malformed addresses render an
// empty payload without throwing (T-vsi-01); (4) the screen renders the ChannelHeader
// (avatar + AddressPill + reputation + earnings via UsdcAmount) and the CardGrid of the
// creator's apis, with the empty-state line when the creator has none.
//
// Mirrors discover.test.ts (real FixtureAdapter for the loader) and landing.test.tsx
// (vi.doMock of react-router for the screen). The fixture creator is FIXTURE_CREATOR
// (0x1111...1111) and getResourceDetail returns the SAME detail for every id, so the
// loader associates BOTH listed fixture cards to FIXTURE_CREATOR.
import { describe, it, expect, vi } from "vitest";
import { FIXTURE_CREATOR } from "../app/fixtures/index";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("creator-profile loader (read-through by creator)", () => {
  it("returns the creator's cards (owner resolved via getResourceDetail) + aggregated totals", async () => {
    const { loader } = await import("../app/routes/creators.$address");
    const data = await loader({
      request: new Request(`http://x/creators/${FIXTURE_CREATOR}`),
      params: { address: FIXTURE_CREATOR },
      context: {},
    } as never);

    // Both fixture cards are owned by FIXTURE_CREATOR (getResourceDetail returns the same
    // detail for every id), so both associate to this channel.
    expect(data.cards.length).toBeGreaterThanOrEqual(1);
    expect(data.apiCount).toBe(data.cards.length);
    // decimals came from a runtime read through the adapter (not a literal).
    expect(typeof data.decimals).toBe("number");
    // reputation + earnings are aggregated bigints; calls is a plain count.
    expect(typeof data.reputation).toBe("bigint");
    expect(typeof data.totalEarnings).toBe("bigint");
    expect(typeof data.totalCalls).toBe("number");
    // the aggregated earnings are the summed creatorShare (a positive projected value).
    expect(data.totalEarnings).toBeGreaterThan(0n);
  });

  it("resolves the creator association THROUGH the getResourceDetail seam (spy-asserted)", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { getResourceDetail: () => unknown },
      "getResourceDetail",
    );

    const { loader } = await import("../app/routes/creators.$address");
    await loader({
      request: new Request(`http://x/creators/${FIXTURE_CREATOR}`),
      params: { address: FIXTURE_CREATOR },
      context: {},
    } as never);

    // The loader resolved each listed card's owner through the adapter seam (not invented).
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns an empty payload (zero apis) for a syntactically valid but unowned address", async () => {
    const { loader } = await import("../app/routes/creators.$address");
    const data = await loader({
      request: new Request(`http://x/creators/${ZERO_ADDRESS}`),
      params: { address: ZERO_ADDRESS },
      context: {},
    } as never);

    expect(data.apiCount).toBe(0);
    expect(data.cards.length).toBe(0);
    expect(data.totalEarnings).toBe(0n);
    expect(data.totalCalls).toBe(0);
    // decimals is still an honest runtime read even for an unknown creator.
    expect(typeof data.decimals).toBe("number");
  });

  it("returns an empty payload for a malformed address without throwing", async () => {
    const { loader } = await import("../app/routes/creators.$address");
    const data = await loader({
      request: new Request("http://x/creators/not-an-address"),
      params: { address: "not-an-address" },
      context: {},
    } as never);

    expect(data.apiCount).toBe(0);
    expect(data.cards.length).toBe(0);
  });
});

describe("creator-profile screen (channel header + apis grid)", () => {
  const TWO_CARDS = [
    {
      resourceId: "0x00000000000000000000000000000000000000000000000000000000000000a1",
      agentId: "42",
      slug: "weather-now",
      category: "data",
      pricing: { model: "flat", base: "10000", perKB: "0", max: "10000" },
      reputation: 12n,
      uptime: 0.98,
      bond: 5000000n,
      active: true,
    },
    {
      resourceId: "0x00000000000000000000000000000000000000000000000000000000000000b2",
      agentId: "43",
      slug: "summarize-text",
      category: "compute",
      pricing: { model: "metered", base: "2000", perKB: "500", max: "50000" },
      reputation: 7n,
      uptime: 0.95,
      bond: 8000000n,
      active: true,
    },
  ];

  async function renderScreen(data: unknown) {
    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        useLoaderData: () => data,
      };
    });
    const { render, screen, within } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../app/routes/creators.$address");
    render(React.createElement(mod.default));
    return { screen, within };
  }

  it("renders the channel header: avatar + address + reputation + earnings via UsdcAmount", async () => {
    const { screen, within } = await renderScreen({
      address: FIXTURE_CREATOR,
      cards: TWO_CARDS,
      decimals: 6,
      apiCount: 2,
      reputation: 19n,
      totalCalls: 256,
      totalEarnings: 1792000n,
    });

    // Scope the header assertions inside the channel-header (the cards in the grid also
    // carry a reputation-badge in their creator chip, so query within the header only).
    const header = screen.getByTestId("channel-header");
    expect(header).toBeInTheDocument();
    expect(within(header).getByTestId("creator-avatar")).toBeInTheDocument();
    expect(within(header).getByTestId("reputation-badge")).toBeInTheDocument();
    expect(within(header).getByTestId("address-pill")).toBeInTheDocument();
    // earnings render through the single money surface (not hand-formatted).
    expect(within(header).getByTestId("usdc-amount")).toBeInTheDocument();
  });

  it("renders the apis grid with the creator's cards", async () => {
    const { screen } = await renderScreen({
      address: FIXTURE_CREATOR,
      cards: TWO_CARDS,
      decimals: 6,
      apiCount: 2,
      reputation: 19n,
      totalCalls: 256,
      totalEarnings: 1792000n,
    });

    expect(screen.getByText("weather-now")).toBeInTheDocument();
    expect(screen.getByText("summarize-text")).toBeInTheDocument();
    expect(screen.getAllByTestId("resource-card").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the CardGrid empty-state line when the creator has no apis", async () => {
    const { screen } = await renderScreen({
      address: ZERO_ADDRESS,
      cards: [],
      decimals: 6,
      apiCount: 0,
      reputation: 0n,
      totalCalls: 0,
      totalEarnings: 0n,
    });

    expect(screen.getByText(/nothing here yet\./i)).toBeInTheDocument();
    expect(screen.getByText(/utter the first one\./i)).toBeInTheDocument();
  });
});
