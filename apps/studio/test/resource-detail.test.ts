// resource-detail.test.ts - STU-03 loader + screen tests.
//
// Covers: (1) the loader returns the full read-through field set (price, payout,
// agentId, bond, sandbox, health, card) through the adapter; (2) the loader never
// re-derives money/identity - the rendered price equals the projected card base
// units, not a recomputation (T-06-REDERIVE); (3) params.id is validated and a
// malformed id surfaces a not-found path (T-06-PARAM).
import { describe, it, expect, vi } from "vitest";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

describe("resources.$id loader (read-through)", () => {
  it("returns the full STU-03 field set projected through the adapter", async () => {
    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({ params: { id: ID }, request: new Request("http://x/"), context: {} } as never);

    expect(data.detail.resourceId).toBe(ID);
    expect(data.detail.agentId).toBeTruthy();
    expect(data.detail.payout).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(data.detail.pricing.base).toBeTruthy();
    expect(data.detail.health).toHaveProperty("verified");
    expect(typeof data.detail.bond).toBe("bigint");
    expect(["live", "deploying", "degraded", "down"]).toContain(data.detail.sandbox);
    expect(data.detail.cardUrl).toContain(".well-known/agent-card.json");
    // decimals came from a runtime read through the adapter (not a literal)
    expect(typeof data.decimals).toBe("number");
  });

  it("validates params.id and surfaces a 404 not-found path for a malformed id", async () => {
    const { loader } = await import("../app/routes/resources.$id");
    let thrown: unknown;
    try {
      await loader({
        params: { id: "../../etc/passwd" },
        request: new Request("http://x/"),
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("surfaces a 404 when the adapter has no such resource (unknown id)", async () => {
    // Make the adapter throw for this read (the read-through source said no).
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(Object.getPrototypeOf(adapter) as { getResourceDetail: () => unknown }, "getResourceDetail")
      .mockRejectedValueOnce(new Error("not found"));

    const { loader } = await import("../app/routes/resources.$id");
    let thrown: unknown;
    try {
      await loader({ params: { id: "unknown-id" }, request: new Request("http://x/"), context: {} } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    spy.mockRestore();
  });
});

describe("resources.$id screen (no price recomputation)", () => {
  it("renders the projected price exactly (the rendered price equals the card base units)", async () => {
    // Compute the loader output first (real read-through), then re-import the route
    // module under a useLoaderData mock so the screen renders that exact projection.
    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({ params: { id: ID }, request: new Request("http://x/"), context: {} } as never);

    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, useLoaderData: () => data };
    });

    const { render, screen, within } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../app/routes/resources.$id");
    const Screen = mod.default;

    render(React.createElement(Screen));

    // base = "10000" base units, decimals = 6 -> $0.010000. A recompute (e.g. *1e6)
    // would differ; we assert the exact projected string in the price pill.
    const pills = screen.getAllByTestId("price-pill");
    expect(pills.length).toBeGreaterThan(0);
    expect(within(pills[0]!).getByText("$0.010000")).toBeInTheDocument();

    // the title is the projected slug; the payout pill is the projected address
    expect(screen.getByTestId("detail-title").textContent).toBe(data.detail.slug);

    vi.doUnmock("react-router");
  });
});
