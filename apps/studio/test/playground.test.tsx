// playground.test.tsx - the STU-03 Playground: Run + the 402 paywall beat + the
// metered ticking + the copyable MCP-connect block.
//
// Covers:
//   (1) PlaygroundPlayer Run drives adapter.runPlayground (reserve-before-run via the
//       frozen gate); it never calls a handler against an unreserved auth (no free-
//       compute) - the Run is wired through the adapter seam, not an inline fetch.
//   (2) An unfunded buyer triggers the PaywallSheet: the 402 red bar + the mono price
//       from the accepts quote + pay-from-balance / deposit-and-pay; paying streams the
//       result (it is NOT an error).
//   (3) MeteredTicker mirrors computeMeteredAmount, clamped to the cap: the displayed
//       value never exceeds the cap; a metered render carries the "<= $X cap" suffix.
//   (4) McpConnectBlock renders a copyable config + a copy-config control (no buyer
//       client this phase).
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { computeMeteredAmount, type Pricing } from "@utter/x402-arc";
import { PlaygroundPlayer } from "../app/components/playground/PlaygroundPlayer";
import { PaywallSheet } from "../app/components/playground/PaywallSheet";
import { MeteredTicker } from "../app/components/playground/MeteredTicker";
import { McpConnectBlock } from "../app/components/detail/McpConnectBlock";

const METERED_PRICING: Pricing = {
  model: "metered",
  base: "2000",
  perKB: "500",
  computeMultiplier: "100",
  maxResponseBytes: 1_048_576,
};

/** A minimal accepts quote (the 402 escrow entry) the PaywallSheet reads the price from. */
const QUOTE = {
  scheme: "utter-escrow" as const,
  network: "eip155:5042002" as const,
  asset: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  escrow: "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154" as `0x${string}`,
  maxAmountRequired: "50000",
  payTo: "0x00000000000000000000000000000000000000000000000000000000000000a1" as `0x${string}`,
  maxTimeoutSeconds: 30,
  pricing: METERED_PRICING,
};

describe("PlaygroundPlayer (Run drives runPlayground via the frozen gate)", () => {
  it("renders the request builder + the triangle Run control", () => {
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByTestId("playground-run")).toBeInTheDocument();
    expect(screen.getByTestId("playground-request")).toBeInTheDocument();
  });

  it("Run calls the injected runPlayground (adapter seam) - never an inline handler call", async () => {
    const onRun = vi.fn().mockResolvedValue({
      paid: true,
      debitAmount: 12000n,
      body: { echo: "hello", length: 5 },
    });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-run"));

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    // The response renders the body returned by the gate-backed runPlayground.
    await waitFor(() =>
      expect(screen.getByTestId("playground-response").textContent).toContain("echo"),
    );
  });

  it("leaves the response pane out of running… and shows the error when onRun rejects", async () => {
    // FIX 1b backstop: a rejecting onRun (e.g. a failed fetch/json against a hosted run)
    // must land in the done-with-error state, not hang the pane on "running…" forever.
    const onRun = vi.fn().mockRejectedValue(new Error("client boom"));
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-run"));

    await waitFor(() => {
      const pane = screen.getByTestId("playground-response");
      expect(pane.textContent).not.toContain("running…");
      expect(pane.textContent).toContain("client boom");
    });
  });

  it("shows the 402 paywall beat when the result reports an unfunded buyer", async () => {
    const onRun = vi.fn().mockResolvedValue({
      paid: false,
      debitAmount: 0n,
      body: null,
      paywall: { quote: QUOTE },
    });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-run"));
    await waitFor(() => expect(screen.getByTestId("paywall-sheet")).toBeInTheDocument());
  });
});

describe("PaywallSheet (the 402 overlay beat from the accepts quote)", () => {
  it("renders the 402 red bar + the mono cap price read from the quote (never recomputed)", () => {
    render(<PaywallSheet quote={QUOTE} decimals={6} funded={false} onPay={vi.fn()} />);
    const sheet = screen.getByTestId("paywall-sheet");
    // the 402 red-bar beat marker carries the comp copy
    expect(within(sheet).getByTestId("paywall-bar").textContent).toMatch(/402 · PAYMENT REQUIRED/);
    // the call-to-action line
    expect(within(sheet).getByText(/pay to run this call/i)).toBeInTheDocument();
    // cap 50000 base units, decimals 6 -> $0.05 read straight from the quote (it
    // appears both in the capped-at line and the pay button label)
    expect(within(sheet).getAllByText("$0.05").length).toBeGreaterThan(0);
  });

  it("offers a pay-from-balance control, a deposit & pay link (-> /wallet), and a cancel", () => {
    render(<PaywallSheet quote={QUOTE} decimals={6} funded onPay={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("paywall-pay").textContent).toMatch(/from balance/i);
    const deposit = screen.getByTestId("paywall-deposit");
    expect(deposit.textContent).toMatch(/deposit & pay/i);
    expect(deposit).toHaveAttribute("href", "/wallet");
    expect(screen.getByTestId("paywall-cancel").textContent).toMatch(/cancel/i);
  });

  it("invokes onPay when the pay control is clicked (then the result streams)", () => {
    const onPay = vi.fn();
    render(<PaywallSheet quote={QUOTE} decimals={6} funded onPay={onPay} />);
    fireEvent.click(screen.getByTestId("paywall-pay"));
    expect(onPay).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel when the cancel control is clicked", () => {
    const onCancel = vi.fn();
    render(<PaywallSheet quote={QUOTE} decimals={6} funded onPay={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("paywall-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("MeteredTicker (mirrors computeMeteredAmount, clamped to the cap)", () => {
  it("renders a value that never exceeds the cap and matches computeMeteredAmount", () => {
    const cap = 50000n;
    const bytes = 2048;
    const ms = 250;
    const expected = computeMeteredAmount(METERED_PRICING, bytes, ms, cap);

    render(
      <MeteredTicker
        pricing={METERED_PRICING}
        cap={cap}
        decimals={6}
        bodyBytes={bytes}
        handlerMs={ms}
        animate={false}
      />,
    );
    const ticker = screen.getByTestId("metered-ticker");
    // the displayed (primary) amount equals the gate math (no re-implementation). Format
    // the expected base units the same way UsdcAmount does (test-only divmod, decimals 6).
    const value = within(ticker).getByTestId("metered-value");
    const whole = expected / 1000000n; // test-only display check, not a render-path literal
    const frac = (expected % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    const display = frac.length > 0 ? `$${whole}.${frac}` : `$${whole}`;
    expect(value.textContent).toContain(display);
    // the cap-suffix beat for metered
    expect(within(ticker).getByTestId("metered-cap").textContent).toMatch(/cap/i);
  });

  it("clamps the displayed amount to the cap when the computed amount would exceed it", () => {
    const cap = 1000n; // tiny cap: base 2000 alone already exceeds it
    const expected = computeMeteredAmount(METERED_PRICING, 4096, 500, cap);
    expect(expected).toBe(cap); // sanity: computeMeteredAmount clamps to cap

    render(
      <MeteredTicker
        pricing={METERED_PRICING}
        cap={cap}
        decimals={6}
        bodyBytes={4096}
        handlerMs={500}
        animate={false}
      />,
    );
    const ticker = screen.getByTestId("metered-ticker");
    // the ticker reports the clamped (== cap) amount, never more. Target the primary
    // value distinctly (the cap suffix also shows $0.001 when clamped).
    expect(within(ticker).getByTestId("metered-value").textContent).toContain("$0.001");
  });
});

describe("McpConnectBlock (copyable config only - no buyer client this phase)", () => {
  it("renders a copyable config block + a copy-config control", () => {
    render(<McpConnectBlock resourceId="0xabc" cardUrl="https://x.example.com/.well-known/agent-card.json" />);
    expect(screen.getByTestId("mcp-connect")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-config")).toBeInTheDocument();
    expect(screen.getByText(/copy config/i)).toBeInTheDocument();
  });

  it("includes the resource card URL in the rendered config", () => {
    render(<McpConnectBlock resourceId="0xabc" cardUrl="https://weather.example.com/.well-known/agent-card.json" />);
    expect(screen.getByTestId("mcp-config").textContent).toContain(
      "weather.example.com/.well-known/agent-card.json",
    );
  });
});
