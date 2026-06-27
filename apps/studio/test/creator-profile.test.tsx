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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelHeader } from "../app/components/profile/ChannelHeader";
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
    // repScore is an honest 0-100 score derived from the owned cards' real uptime.
    expect(typeof data.repScore).toBe("number");
    expect(data.repScore).toBeGreaterThanOrEqual(0);
    expect(data.repScore).toBeLessThanOrEqual(100);
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

  it("flips revenueAvailable to false (no throw) when an owned card's getRevenue throws", async () => {
    // Live-shaped failure: an owned card's facilitator read throws. The loader does not
    // throw; it returns revenueAvailable false so the header shows a dash. Driven by a
    // STUB throw (the fixture never throws).
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(Object.getPrototypeOf(adapter) as { getRevenue: () => unknown }, "getRevenue")
      .mockRejectedValueOnce(new Error("facilitator unreachable"));

    const { loader } = await import("../app/routes/creators.$address");
    const data = await loader({
      request: new Request(`http://x/creators/${FIXTURE_CREATOR}`),
      params: { address: FIXTURE_CREATOR },
      context: {},
    } as never);

    expect(data.revenueAvailable).toBe(false);
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
    // an unknown creator has no cards, so repScore is honestly 0.
    expect(data.repScore).toBe(0);
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

  it("renders the channel header: banner avatar + identity + meter + earnings via UsdcAmount", async () => {
    const { screen, within } = await renderScreen({
      address: FIXTURE_CREATOR,
      cards: TWO_CARDS,
      decimals: 6,
      apiCount: 2,
      reputation: 19n,
      totalCalls: 256,
      totalEarnings: 1792000n,
      repScore: 96,
    });

    // Scope the header assertions inside the channel-header (the cards in the grid also
    // carry reputation/avatar marks in their creator chip, so query within the header only).
    const header = screen.getByTestId("channel-header");
    expect(header).toBeInTheDocument();
    // the 88px avatar circle overlapping the banner.
    expect(within(header).getByTestId("creator-avatar")).toBeInTheDocument();
    // the comp identity marks: a verified-creator pill + the address handle + follow button.
    expect(within(header).getByTestId("verified-creator-pill")).toBeInTheDocument();
    expect(within(header).getByText("verified creator")).toBeInTheDocument();
    expect(within(header).getByText("+ follow")).toBeInTheDocument();
    // the 10-segment reputation meter carries the derived score (not feedbackCount).
    const meter = within(header).getByTestId("reputation-meter");
    expect(meter).toHaveAttribute("data-score", "96");
    expect(within(header).getByText(/REPUTATION · 96\/100/)).toBeInTheDocument();
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
      repScore: 96,
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
      repScore: 0,
    });

    expect(screen.getByText(/nothing here yet\./i)).toBeInTheDocument();
    expect(screen.getByText(/utter the first one\./i)).toBeInTheDocument();
  });
});

describe("ChannelHeader revenueAvailable", () => {
  const BASE = {
    address: FIXTURE_CREATOR,
    repScore: 96,
    reputation: 19n,
    apiCount: 2,
    totalCalls: 256,
    totalEarnings: 1792000n,
    decimals: 6,
  };

  it("renders a dash for TOTAL CALLS and EARNINGS when revenueAvailable is false", () => {
    render(<ChannelHeader {...BASE} revenueAvailable={false} />);
    const header = screen.getByTestId("channel-header");
    // the calls + earnings money cells are unknown -> dashes, never a fabricated number
    expect(within(header).queryByTestId("usdc-amount")).toBeNull();
    expect(within(header).getAllByText("-").length).toBeGreaterThanOrEqual(2);
    // the APIS count + the reputation meter still render (they do not depend on revenue)
    expect(within(header).getByText(String(BASE.apiCount))).toBeInTheDocument();
    expect(within(header).getByTestId("reputation-meter")).toBeInTheDocument();
  });

  it("renders the real numbers + UsdcAmount when revenueAvailable is omitted (default true)", () => {
    render(<ChannelHeader {...BASE} />);
    const header = screen.getByTestId("channel-header");
    // earnings render through the single money surface; the calls figure is compacted
    expect(within(header).getByTestId("usdc-amount")).toBeInTheDocument();
    expect(within(header).getByText("256")).toBeInTheDocument();
  });
});

describe("ChannelHeader follow toggle", () => {
  const PROPS = {
    address: FIXTURE_CREATOR,
    repScore: 50,
    reputation: 5n,
    apiCount: 1,
    totalCalls: 10,
    totalEarnings: 1000n,
    decimals: 6,
  };

  it("toggles follow state, flips aria-pressed + label, and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(<ChannelHeader {...PROPS} />);

    const button = screen.getByRole("button", { name: /\+ follow/i });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    const followingBtn = screen.getByRole("button", { name: /^following$/i });
    expect(followingBtn).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(`utter:follow:${FIXTURE_CREATOR}`)).toBe("1");

    await user.click(followingBtn);
    expect(screen.getByRole("button", { name: /\+ follow/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(localStorage.getItem(`utter:follow:${FIXTURE_CREATOR}`)).toBeNull();
  });

  it("hydrates the following state from localStorage after mount", async () => {
    localStorage.setItem(`utter:follow:${FIXTURE_CREATOR}`, "1");
    render(<ChannelHeader {...PROPS} />);
    expect(await screen.findByRole("button", { name: /^following$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
