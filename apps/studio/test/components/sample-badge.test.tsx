// sample-badge.test.tsx - the SampleBadge primitive + the demo-panel markers.
//
// SampleBadge marks panels that have no live data source yet so representative data
// never reads as live. These tests pin (1) the primitive renders its label (default +
// custom), and (2) the genuinely-demo panels carry the badge: the wallet tx-history +
// spend-caps, the dashboard charts (RevenuePanel), and the mcp recent-paid-calls feed
// + spend-cap meter. Adapter-sourced surfaces are NOT badged (verified elsewhere).
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import * as React from "react";
import { SampleBadge } from "../../app/components/primitives/SampleBadge";
import { RevenuePanel } from "../../app/components/dashboard/RevenuePanel";
import McpConnectRoute from "../../app/routes/mcp";

// wallet.tsx (and its mounted deposit/withdraw forms) read wagmi hooks; mock the full
// surface so the route renders with no browser wallet.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useChainId: () => 0,
  useSwitchChain: () => ({ switchChain: () => undefined, isPending: false }),
  useWriteContract: () => ({ writeContractAsync: async () => undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({
    data: undefined,
    isSuccess: false,
    isError: false,
    error: undefined,
    isLoading: false,
  }),
}));

vi.mock("wagmi/connectors", () => ({ injected: () => ({ type: "injected" }) }));

describe("SampleBadge", () => {
  it("renders the default 'sample data' label", () => {
    render(<SampleBadge />);
    expect(screen.getByTestId("sample-badge").textContent).toBe("sample data");
  });

  it("renders a custom label and the subtle mono-uppercase ink-faint style", () => {
    render(<SampleBadge label="representative" />);
    const badge = screen.getByTestId("sample-badge");
    expect(badge.textContent).toBe("representative");
    expect(badge.className).toMatch(/uppercase/);
    expect(badge.className).toMatch(/text-ink-faint/);
  });
});

describe("dashboard charts are marked sample (RevenuePanel)", () => {
  it("badges each no-live-source chart card", () => {
    render(
      <RevenuePanel
        earnings={896000n}
        totalCalls={128}
        liveApis={1}
        strikes={0}
        decimals={6}
        revenueSeries={[1, 2, 3]}
        callsSeries={[3, 2, 1]}
      />,
    );
    const charts = screen.getAllByTestId("chart-card");
    expect(charts.length).toBe(2);
    for (const card of charts) {
      expect(within(card).getByTestId("sample-badge")).toBeInTheDocument();
    }
  });
});

describe("mcp demo panels are marked sample", () => {
  async function renderMcp() {
    // The route renders react-router <Link>s; mount inside a MemoryRouter.
    const { MemoryRouter } = await import("react-router");
    render(React.createElement(MemoryRouter, null, React.createElement(McpConnectRoute)));
  }

  it("badges the recent-paid-calls feed and the spend-cap meter", async () => {
    await renderMcp();
    const badges = screen.getAllByTestId("sample-badge");
    // both the RECENT PAID CALLS feed and the SPEND CAP meter carry a badge
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("RECENT PAID CALLS")).toBeInTheDocument();
    expect(screen.getByText("SPEND CAP")).toBeInTheDocument();
  });
});

describe("wallet demo panels are marked sample", () => {
  async function renderWallet() {
    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, useLoaderData: () => ({ decimals: 6 }) };
    });
    const rtl = await import("@testing-library/react");
    const ReactMod = await import("react");
    const mod = await import("../../app/routes/wallet");
    rtl.render(ReactMod.createElement(mod.default));
    return rtl;
  }

  it("badges the transaction-history and agent-spend-caps panels", async () => {
    const { screen: scr, within: wn } = await renderWallet();
    const tx = scr.getByTestId("wallet-tx-history");
    const caps = scr.getByTestId("wallet-agent-caps");
    expect(wn(tx).getByTestId("sample-badge")).toBeInTheDocument();
    expect(wn(caps).getByTestId("sample-badge")).toBeInTheDocument();
    vi.doUnmock("react-router");
  });
});
