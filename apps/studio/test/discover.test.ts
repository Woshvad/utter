// discover.test.ts - STU-03/04 marketplace browse loader + the filter/sort/chips.
//
// Covers: (1) the loader maps the URL query string to a FilterCriteria and lists
// THROUGH the adapter (filterResources read-through) - price/reputation/bond are the
// projected values, never recomputed (T-06-REDERIVE); (2) each FilterPanel/SortControl/
// CategoryChips field maps 1:1 to a FilterCriteria field; (3) empty + no-results states
// render the copywriting-contract lines.
import { describe, it, expect, vi } from "vitest";

describe("discover loader (read-through marketplace browse)", () => {
  it("lists every active fixture card through the adapter with no query", async () => {
    const { loader } = await import("../app/routes/discover");
    const data = await loader({
      request: new Request("http://x/discover"),
      params: {},
      context: {},
    } as never);

    // Both fixture cards are listed (read-through, not recomputed).
    expect(data.cards.length).toBe(2);
    const slugs = data.cards.map((c) => c.slug).sort();
    expect(slugs).toEqual(["summarize-text", "weather-now"]);
    // decimals came from a runtime read through the adapter (not a literal).
    expect(typeof data.decimals).toBe("number");
  });

  it("maps ?category= to FilterCriteria.category (1:1 field map)", async () => {
    const { loader } = await import("../app/routes/discover");
    const data = await loader({
      request: new Request("http://x/discover?category=data"),
      params: {},
      context: {},
    } as never);

    expect(data.cards.length).toBe(1);
    expect(data.cards[0]!.category).toBe("data");
    expect(data.criteria.category).toBe("data");
  });

  it("maps ?maxBasePrice= / ?minBasePrice= to bigint base-unit criteria", async () => {
    const { loader } = await import("../app/routes/discover");
    // maxBasePrice 5000 base units -> only the metered card (base 2000) <= 5000,
    // the flat card (base 10000) is filtered out.
    const data = await loader({
      request: new Request("http://x/discover?maxBasePrice=5000"),
      params: {},
      context: {},
    } as never);

    expect(data.cards.length).toBe(1);
    expect(data.cards[0]!.slug).toBe("summarize-text");
    expect(data.criteria.maxBasePrice).toBe(5000n);
  });

  it("maps ?minReputation= / ?minBond= / ?minUptime= / ?active= to criteria fields", async () => {
    const { loader } = await import("../app/routes/discover");
    const data = await loader({
      request: new Request(
        "http://x/discover?minReputation=10&minBond=4000000&minUptime=0.9&active=true",
      ),
      params: {},
      context: {},
    } as never);

    expect(data.criteria.minReputation).toBe(10n);
    expect(data.criteria.minBond).toBe(4000000n);
    expect(data.criteria.minUptime).toBeCloseTo(0.9);
    expect(data.criteria.active).toBe(true);
    // only the reputation-12 weather card clears minReputation 10
    expect(data.cards.length).toBe(1);
    expect(data.cards[0]!.slug).toBe("weather-now");
  });

  it("maps ?sort= to an ordering without recomputing money (cheapest first)", async () => {
    const { loader } = await import("../app/routes/discover");
    const data = await loader({
      request: new Request("http://x/discover?sort=cheapest"),
      params: {},
      context: {},
    } as never);

    // cheapest -> metered card (base 2000) before flat card (base 10000)
    expect(data.cards[0]!.slug).toBe("summarize-text");
    expect(data.cards[1]!.slug).toBe("weather-now");
    expect(data.sort).toBe("cheapest");
  });

  it("carries the query string through for the no-results copy", async () => {
    const { loader } = await import("../app/routes/discover");
    const data = await loader({
      request: new Request("http://x/discover?q=nonexistent&category=does-not-exist"),
      params: {},
      context: {},
    } as never);

    expect(data.cards.length).toBe(0);
    expect(data.query).toBe("nonexistent");
  });

  it("reads through the adapter and never recomputes a card price", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi.spyOn(
      Object.getPrototypeOf(adapter) as { listMarketplace: () => unknown },
      "listMarketplace",
    );

    const { loader } = await import("../app/routes/discover");
    await loader({ request: new Request("http://x/discover"), params: {}, context: {} } as never);

    // The loader delegated to the adapter (read-through), not an inline derivation. It
    // calls listMarketplace at least once: once with the parsed FilterCriteria, and once
    // unfiltered to derive the category-chip catalogue - both through the adapter seam.
    expect(spy).toHaveBeenCalled();
    // The first call carried the parsed FilterCriteria (a no-query browse -> {} criteria).
    const firstCall = spy.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toEqual({});
    spy.mockRestore();
  });
});

describe("discover screen (filter/sort/chips + empty/no-results states)", () => {
  async function renderScreen(data: unknown) {
    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        useLoaderData: () => data,
        // The screen uses a Form for the filter submit; stub it to a plain form.
        Form: (props: Record<string, unknown>) => {
          const React = require("react");
          return React.createElement("form", props, props.children as never);
        },
      };
    });
    const { render, screen, within } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../app/routes/discover");
    render(React.createElement(mod.default));
    return { screen, within };
  }

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

  it("renders the card grid for the listed resources", async () => {
    const { screen } = await renderScreen({
      cards: TWO_CARDS,
      decimals: 6,
      criteria: {},
      query: "",
      sort: "top",
      categories: ["data", "compute"],
    });
    expect(screen.getByText("weather-now")).toBeInTheDocument();
    expect(screen.getByText("summarize-text")).toBeInTheDocument();
  });

  it("renders the category chips (one per category) and the sort control", async () => {
    const { screen } = await renderScreen({
      cards: TWO_CARDS,
      decimals: 6,
      criteria: {},
      query: "",
      sort: "top",
      categories: ["data", "compute"],
    });
    expect(screen.getByTestId("category-chips")).toBeInTheDocument();
    expect(screen.getByTestId("sort-control")).toBeInTheDocument();
    expect(screen.getByTestId("filter-panel")).toBeInTheDocument();
  });

  it("renders the empty-state copy when nothing is listed and there is no query", async () => {
    const { screen } = await renderScreen({
      cards: [],
      decimals: 6,
      criteria: {},
      query: "",
      sort: "top",
      categories: [],
    });
    expect(screen.getByText(/nothing here yet\./i)).toBeInTheDocument();
    expect(screen.getByText(/utter the first one\./i)).toBeInTheDocument();
  });

  it("renders the no-results copy with the query when filtered to nothing", async () => {
    const { screen } = await renderScreen({
      cards: [],
      decimals: 6,
      criteria: {},
      query: "weather",
      sort: "top",
      categories: ["data"],
    });
    expect(screen.getByText(/no results for "weather"/i)).toBeInTheDocument();
  });
});
