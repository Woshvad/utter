// landing.test.tsx - the `/` landing front-door loader + the full-bleed screen.
//
// Covers: (1) the loader lists the top marketplace cards THROUGH the adapter
// (read-through, T-v7q-02) and reads decimals at runtime (no literal); (2) the loader
// delegated to adapter.listMarketplace({}) (the unfiltered top-list, spy-asserted); (3)
// the screen renders the hero tagline + dual CTAs (/create, /discover), exactly five
// how-it-works steps, and the marketplace strip reusing ResourceCard. Mirrors the
// structure of discover.test.ts (real FixtureAdapter for the loader; vi.doMock of
// react-router for the screen).
import { describe, it, expect, vi } from "vitest";

describe("landing loader (read-through top marketplace)", () => {
  it("returns top marketplace cards + a numeric runtime decimals", async () => {
    const { loader } = await import("../app/routes/_index");
    const data = await loader({
      request: new Request("http://x/"),
      params: {},
      context: {},
    } as never);

    // The fixture marketplace feeds the strip (top four; the fixture has 1..4 cards).
    expect(data.cards.length).toBeGreaterThanOrEqual(1);
    expect(data.cards.length).toBeLessThanOrEqual(4);
    // decimals came from a runtime read through the adapter (not a literal).
    expect(typeof data.decimals).toBe("number");
  });

  it("lists through the adapter with the unfiltered top-list criteria", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { listMarketplace: () => unknown },
      "listMarketplace",
    );

    const { loader } = await import("../app/routes/_index");
    await loader({ request: new Request("http://x/"), params: {}, context: {} } as never);

    // The loader delegated to the adapter (read-through), not an inline derivation, and
    // called it with the unfiltered top-list criteria ({}).
    expect(spy).toHaveBeenCalled();
    const firstCall = spy.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toEqual({});
    spy.mockRestore();
  });
});

describe("landing screen (hero + how-it-works + marketplace strip)", () => {
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
        // Stub Link to a plain anchor that honors `to` as href so we can read CTAs.
        Link: (props: Record<string, unknown>) => {
          const React = require("react");
          const { to, children, ...rest } = props;
          return React.createElement("a", { href: to, ...rest }, children as never);
        },
      };
    });
    const { render, screen } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../app/routes/_index");
    render(React.createElement(mod.default));
    return { screen };
  }

  it("renders the hero with the tagline", async () => {
    const { screen } = await renderScreen({ cards: TWO_CARDS, decimals: 6 });
    expect(screen.getByTestId("landing-hero")).toBeInTheDocument();
    // The h1 carries an explicit <br/> per the comp, so the tagline is two text nodes.
    expect(screen.getByText(/you utter a sentence;/i)).toBeInTheDocument();
    expect(screen.getByText(/you get a paid api\./i)).toBeInTheDocument();
  });

  it("renders exactly five how-it-works steps in the paper block", async () => {
    const { screen } = await renderScreen({ cards: TWO_CARDS, decimals: 6 });
    expect(screen.getByTestId("landing-howitworks")).toBeInTheDocument();
    expect(screen.getAllByTestId("how-step")).toHaveLength(5);
  });

  it("renders the marketplace strip reusing ResourceCard for the loader cards", async () => {
    const { screen } = await renderScreen({ cards: TWO_CARDS, decimals: 6 });
    expect(screen.getByTestId("landing-marketplace")).toBeInTheDocument();
    expect(screen.getAllByTestId("resource-card").length).toBeGreaterThanOrEqual(1);
    // the projected card slug renders straight through the card
    expect(screen.getByText("weather-now")).toBeInTheDocument();
  });

  it("renders the strip empty-state when there are no cards", async () => {
    const { screen } = await renderScreen({ cards: [], decimals: 6 });
    expect(screen.getByText(/nothing listed yet\./i)).toBeInTheDocument();
  });

  it("links the primary CTA to /create and a secondary CTA to /discover", async () => {
    const { screen } = await renderScreen({ cards: TWO_CARDS, decimals: 6 });
    const createLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/create");
    const discoverLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/discover");
    expect(createLinks.length).toBeGreaterThanOrEqual(1);
    expect(discoverLinks.length).toBeGreaterThanOrEqual(1);
  });
});
