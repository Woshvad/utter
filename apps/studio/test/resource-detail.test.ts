// resource-detail.test.ts - STU-03 loader + screen tests.
//
// Covers: (1) the loader returns the full read-through field set (price, payout,
// agentId, bond, sandbox, health, card) through the adapter; (2) the loader never
// re-derives money/identity - the rendered price equals the projected card base
// units, not a recomputation (T-06-REDERIVE); (3) params.id is validated and a
// malformed id surfaces a not-found path (T-06-PARAM).
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The screen now wires usePayPerCall (the 260622-wlu client pay seam), which reads the
// wagmi useAccount + useWalletClient hooks. Mock wagmi (hoisted, survives resetModules)
// so the screen renders with no browser wallet - mirrors wallet.test.tsx. No pay() is
// invoked by these render tests, so a connected-but-inert wallet client is enough.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useWalletClient: () => ({ data: undefined }),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

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

  it("returns a real adapter-sourced calls (== getRevenue(id).calls) and no p50 field", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);

    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({ params: { id: ID }, request: new Request("http://x/"), context: {} } as never);

    const revenue = await adapter.getRevenue(ID);
    expect(data.calls).toBe(revenue.calls);
    // the fabricated p50 latency is gone from the payload
    expect((data as unknown as Record<string, unknown>).p50).toBeUndefined();
  });

  it("test-it does not crash when the decimals probe throws for a bytes32 (uses the zero address)", async () => {
    // The live-mode "test it" crash was getEscrowBalance(detail.payout) with payout a
    // bytes32 (66-char keccak) -> readUsdcBalance throws via viem isAddress(). Stub
    // getEscrowBalance to mimic that: THROW for a bytes32-shaped argument, SUCCEED for the
    // zero address. If the loader still passed detail.payout it would throw; reading from
    // the zero address proves the fix.
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as {
          getEscrowBalance: (addr: string) => Promise<{ raw: bigint; decimals: number }>;
        },
        "getEscrowBalance",
      )
      .mockImplementation(async (addr: string) => {
        if (/^0x[0-9a-fA-F]{64}$/.test(addr)) {
          throw new Error("invalid address: not a 20-byte address");
        }
        return { raw: 0n, decimals: 6 };
      });

    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({
      params: { id: ID },
      request: new Request("http://x/"),
      context: {},
    } as never);

    // No throw, and a numeric decimals came back from the zero-address probe.
    expect(typeof data.decimals).toBe("number");
    expect(data.decimals).toBe(6);
    spy.mockRestore();
  });

  it("returns calls null (no throw) when getRevenue throws", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(Object.getPrototypeOf(adapter) as { getRevenue: () => unknown }, "getRevenue")
      .mockRejectedValueOnce(new Error("facilitator unreachable"));

    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({
      params: { id: ID },
      request: new Request("http://x/"),
      context: {},
    } as never);

    // a failed revenue read renders the calls stat as unknown, never a crash or zero
    expect(data.calls).toBeNull();
    spy.mockRestore();
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
    // The screen now renders react-router <Link>s (back link, creator chip, related
    // rail), so it must mount inside a Router context (MemoryRouter) - mirrors any
    // route-component render test. No navigation is exercised here.
    const { MemoryRouter } = await import("react-router");
    const mod = await import("../app/routes/resources.$id");
    const Screen = mod.default;

    render(React.createElement(MemoryRouter, null, React.createElement(Screen)));

    // The player is the always-visible hero; its header renders the projected cap via
    // UsdcAmount. cap = max = "10000" base units @ 6dp -> $0.01. A recompute (e.g.
    // *1e6) would differ; we assert the exact projected string straight off the render.
    const monies = screen.getAllByTestId("usdc-amount");
    expect(monies.length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("playground-player")).getByText("$0.01")).toBeInTheDocument();

    // the title is the projected slug
    expect(screen.getByTestId("detail-title").textContent).toBe(data.detail.slug);

    // the title-block stats show the real calls + uptime and NO fabricated p50 latency
    const stats = within(screen.getByTestId("detail-stats"));
    expect(stats.getByText("calls")).toBeInTheDocument();
    expect(stats.getByText("uptime")).toBeInTheDocument();
    expect(stats.queryByText("p50")).toBeNull();
    expect(screen.queryByText(/ms$/)).toBeNull();

    vi.doUnmock("react-router");
  });
});

describe("resource-detail tabs (real adapter content)", () => {
  /**
   * Render the screen against the real loader projection, then click a tab trigger
   * by its accessible name so its (lazily mounted) Radix panel becomes visible. The
   * default fixture pricing is flat; pass an override loader payload for metered tests.
   */
  async function renderScreen(override?: (data: { detail: { pricing: { model: string; perKB: string; max: string; base: string } } }) => void) {
    const { loader } = await import("../app/routes/resources.$id");
    const data = await loader({ params: { id: ID }, request: new Request("http://x/"), context: {} } as never);
    if (override) override(data as never);

    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, useLoaderData: () => data };
    });

    const rtl = await import("@testing-library/react");
    const React = await import("react");
    // The screen renders react-router <Link>s; mount inside a MemoryRouter so the
    // Link context resolves (no navigation is exercised by these tab-content tests).
    const { MemoryRouter } = await import("react-router");
    const mod = await import("../app/routes/resources.$id");
    const user = userEvent.setup();
    rtl.render(React.createElement(MemoryRouter, null, React.createElement(mod.default)));
    return { ...rtl, data, user };
  }

  it("API tab renders an honest OpenAPI descriptor with real pricing/category/agentId", async () => {
    const { screen, user, within, data } = await renderScreen();
    await user.click(screen.getByRole("tab", { name: "api" }));

    const preview = within(screen.getByTestId("openapi-preview"));
    const code = preview.getByTestId("code-block").textContent ?? "";
    // The raw base-unit pricing string, the category, and the agentId are all present.
    expect(code).toContain(data.detail.pricing.base);
    expect(code).toContain(data.detail.category);
    expect(code).toContain(data.detail.agentId);
    // It is OpenAPI-shaped, not a one-field stub.
    expect(code).toContain("openapi");
    expect(code).toContain("x-utter");

    vi.doUnmock("react-router");
  });

  it("Agent card tab renders canonical A2A JSON from real fields, not the old 4-field stub", async () => {
    const { screen, user, within, data } = await renderScreen();
    await user.click(screen.getByRole("tab", { name: "agent card" }));

    const code = within(screen.getByTestId("card-preview")).getByTestId("code-block").textContent ?? "";
    expect(code).toContain(data.detail.slug); // name
    expect(code).toContain(data.detail.agentId);
    expect(code).toContain(data.detail.category);
    expect(code).toContain(data.detail.pricing.model);
    // honest A2A card includes the pricing/x402 block + the resource url, not just 4 fields
    expect(code).toContain("pricing");
    expect(code).toContain("x402");
    expect(code).toContain("url");

    vi.doUnmock("react-router");
  });

  it("Reputation tab renders verified + bond and no fabricated feedbackCount=0 badge", async () => {
    const { screen, user, within } = await renderScreen();
    await user.click(screen.getByRole("tab", { name: "reputation" }));

    const region = within(screen.getByTestId("detail-reputation"));
    expect(region.getByTestId("verified-badge")).toBeInTheDocument();
    expect(region.getByTestId("bond-badge")).toBeInTheDocument();
    // the old fabricated zero-count reputation badge is gone
    expect(screen.queryByTestId("reputation-badge")).toBeNull();

    vi.doUnmock("react-router");
  });

  it("Pricing tab renders every money figure via UsdcAmount including the projected base", async () => {
    const { screen, user, within } = await renderScreen();
    await user.click(screen.getByRole("tab", { name: "pricing" }));

    const region = within(screen.getByTestId("detail-pricing"));
    const monies = region.getAllByTestId("usdc-amount");
    expect(monies.length).toBeGreaterThan(0);
    // base = "10000" base units @ 6dp -> $0.01 (the projected fixture base)
    expect(region.getAllByText("$0.01").length).toBeGreaterThan(0);

    vi.doUnmock("react-router");
  });

  it("Pricing tab shows the per-kb price via UsdcAmount when metered", async () => {
    const { screen, user, within } = await renderScreen((data) => {
      // Flip the projection to metered with a non-zero perKB to exercise the branch.
      data.detail.pricing.model = "metered";
      data.detail.pricing.perKB = "500";
      data.detail.pricing.max = "50000";
    });
    await user.click(screen.getByRole("tab", { name: "pricing" }));

    const perKb = within(screen.getByTestId("detail-perkb"));
    // 500 base units @ 6dp -> $0.0005, rendered through UsdcAmount
    expect(perKb.getByTestId("usdc-amount")).toBeInTheDocument();
    expect(perKb.getByText("$0.0005")).toBeInTheDocument();

    vi.doUnmock("react-router");
  });
});

describe("resource-detail render path (no money literal)", () => {
  it("contains no 1e6/10**6//1000000/6n/18n money-scale literal in the route", () => {
    const forbidden = [/1e6/i, /10\s*\*\*\s*6/, /\/\s*1000000/, /\b6n\b/, /\b18n\b/, /BigInt\(\s*6\s*\)/, /BigInt\(\s*18\s*\)/];
    const src = readFileSync(resolve(HERE, "../app/routes/resources.$id.tsx"), "utf8");
    // Strip block + line comments so header prose cannot self-invalidate (mirrors dashboard.test.ts).
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const re of forbidden) {
      expect(stripped, `resources.$id.tsx should carry no money-scale literal (${re})`).not.toMatch(re);
    }
  });
});
