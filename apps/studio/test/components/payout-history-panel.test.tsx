// payout-history-panel.test.tsx - the unified creator PAYOUT LEDGER (money in + out).
//
// The panel reads the connected creator's on-chain withdrawals via usePayoutHistory
// (mocked here to a deterministic state so no chain is touched) and renders the loader's
// getRevenue settle/refund receipts (the `settles` prop) as the money-in side. The tests
// assert: withdrawal rows render (data-kind="withdraw") with a TxLink + UsdcAmount each;
// settle/refund rows render (data-kind="settle"/"refund") with a TxLink + UsdcAmount each;
// loading/error/disconnected states render without throwing; the per-group empty states
// render. A source grep asserts the panel + its hook carry no money literal.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import type { RevenueReceipt } from "../../app/adapter/types";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- usePayoutHistory mock: a deterministic withdrawal history, no chain -----------
type WithdrawalRecord = { tx: `0x${string}`; amount: bigint; blockNumber: bigint };
let payoutState: {
  records?: WithdrawalRecord[];
  decimals?: number;
  loading: boolean;
  error?: string;
} = { records: [], decimals: 6, loading: false };
vi.mock("../../app/wallet/usePayoutHistory", () => ({
  usePayoutHistory: () => payoutState,
}));

const TX_W1 = "0xcccc000000000000000000000000000000000000000000000000000000000001" as const;
const TX_W2 = "0xcccc000000000000000000000000000000000000000000000000000000000002" as const;
const TX_S1 = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a101" as const;
const TX_R1 = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a103" as const;
const EXPLORER = "https://testnet.arcscan.app";
const ADDRESS = "0xabc";

const SETTLES: RevenueReceipt[] = [
  { tx: TX_S1, kind: "settle", amount: 800000n, idemKey: "idem-settle-1" },
  { tx: TX_R1, kind: "refund", amount: 20000n, idemKey: "idem-refund-1" },
];

beforeEach(() => {
  payoutState = {
    records: [
      { tx: TX_W2, amount: 3000000n, blockNumber: 20n },
      { tx: TX_W1, amount: 1000000n, blockNumber: 10n },
    ],
    decimals: 6,
    loading: false,
  };
});

async function renderPanel(props: {
  address?: string;
  settles?: RevenueReceipt[];
}) {
  const { PayoutHistoryPanel } = await import(
    "../../app/components/dashboard/PayoutHistoryPanel"
  );
  render(
    React.createElement(PayoutHistoryPanel, {
      address: props.address,
      settles: props.settles ?? SETTLES,
      explorer: EXPLORER,
      decimals: 6,
    }),
  );
}

describe("PayoutHistoryPanel (withdrawals in + settlements out ledger)", () => {
  it("renders the withdrawal rows from the hook state with a TxLink + UsdcAmount each", async () => {
    await renderPanel({ address: ADDRESS });
    const withdrawRows = screen
      .getAllByTestId("payout-row")
      .filter((r) => r.getAttribute("data-kind") === "withdraw");
    expect(withdrawRows.length).toBe(2);
    // each withdrawal row has a UsdcAmount + a TxLink
    for (const row of withdrawRows) {
      expect(row.querySelector('[data-testid="usdc-amount"]')).not.toBeNull();
      expect(row.querySelector('[data-testid="tx-link"]')).not.toBeNull();
    }
    // 3000000n @ 6dp -> $3 renders
    expect(screen.getByText("$3")).toBeInTheDocument();
  });

  it("renders the settle/refund rows from the settles prop with a TxLink + UsdcAmount each", async () => {
    await renderPanel({ address: ADDRESS });
    const settleRow = screen
      .getAllByTestId("payout-row")
      .find((r) => r.getAttribute("data-kind") === "settle");
    const refundRow = screen
      .getAllByTestId("payout-row")
      .find((r) => r.getAttribute("data-kind") === "refund");
    expect(settleRow).toBeTruthy();
    expect(refundRow).toBeTruthy();
    for (const row of [settleRow!, refundRow!]) {
      expect(row.querySelector('[data-testid="usdc-amount"]')).not.toBeNull();
      expect(row.querySelector('[data-testid="tx-link"]')).not.toBeNull();
    }
  });

  it("shows the loading state for withdrawals without throwing", async () => {
    payoutState = { loading: true };
    await renderPanel({ address: ADDRESS });
    expect(screen.getByTestId("payout-withdrawals-loading")).toBeInTheDocument();
  });

  it("shows the error state for withdrawals without throwing", async () => {
    payoutState = { loading: false, error: "rpc unreachable" };
    await renderPanel({ address: ADDRESS });
    expect(screen.getByTestId("payout-withdrawals-error")).toBeInTheDocument();
  });

  it("shows the disconnected state when there is no address", async () => {
    payoutState = { loading: false };
    await renderPanel({ address: undefined });
    expect(screen.getByTestId("payout-disconnected")).toBeInTheDocument();
  });

  it("renders the per-group empty states when each source is empty", async () => {
    payoutState = { records: [], decimals: 6, loading: false };
    await renderPanel({ address: ADDRESS, settles: [] });
    expect(screen.getByTestId("payout-withdrawals-empty")).toBeInTheDocument();
    expect(screen.getByTestId("payout-settles-empty")).toBeInTheDocument();
  });
});

describe("PayoutHistoryPanel render path carries no money literal (T-06-DECIMALS)", () => {
  it("carries no 5042002 / decimals money literal in the panel + its hook", () => {
    const RENDER_PATH = [
      "../../app/components/dashboard/PayoutHistoryPanel.tsx",
      "../../app/wallet/usePayoutHistory.ts",
    ];
    const forbidden = [
      /5042002/,
      /1e6/i,
      /10\s*\*\*\s*6/,
      /\/\s*1000000/,
      /\b6n\b/,
      /\b18n\b/,
      /BigInt\(\s*6\s*\)/,
      /BigInt\(\s*18\s*\)/,
    ];
    for (const rel of RENDER_PATH) {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const re of forbidden) {
        expect(stripped, `${rel} should carry no literal (${re})`).not.toMatch(re);
      }
    }
  });
});
