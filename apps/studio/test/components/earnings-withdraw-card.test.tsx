// earnings-withdraw-card.test.tsx - the creator "Withdrawable earnings" card (Payout, T58).
//
// The card reads the connected creator's ACCRUED escrow balance (useAccruedEarnings, mocked
// here to a deterministic value so no chain is touched) and offers a Withdraw that REUSES
// the existing escrow.withdraw flow (useWithdraw runs REAL against the wagmi mock). The
// tests assert: the accrued balance renders mono via UsdcAmount; the withdraw is
// confirm-gated (no tx until the modal confirm is clicked, T-06-OUTFLOW); the confirmed
// withdraw calls escrow.withdraw(parseUnits(amount, runtimeDecimals)) on PAYMENT_ESCROW
// (the SAME single tx the wallet route uses, no new path); over-balance + disconnected
// guards disable submit. A source grep asserts the card carries no money literal.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import * as React from "react";
import { parseUnits } from "viem";
import { PAYMENT_ESCROW } from "@utter/chain";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- wagmi mock (mirrors move-money.test.tsx) --------------------------------
const writeContractAsyncMock = vi.fn(
  async (_args: unknown): Promise<`0x${string}`> =>
    "0xtxhash000000000000000000000000000000000000000000000000000000000000",
);
let accountState: { isConnected: boolean; address?: string } = {
  isConnected: true,
  address: "0xabc",
};
let chainIdState = 5042002;

vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: writeContractAsyncMock, isPending: false }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: `0x${string}` }) => ({
    data: hash ? { status: "success" } : undefined,
    isSuccess: Boolean(hash),
    isError: false,
    error: undefined,
    isLoading: false,
  }),
  useAccount: () => accountState,
  useChainId: () => chainIdState,
}));

vi.mock("wagmi/connectors", () => ({ injected: () => ({ type: "injected" }) }));

// --- useAccruedEarnings mock: a deterministic accrued balance, no chain --------
// 12.34 USDC accrued (12340000n @ 6dp), runtime decimals from the (stubbed) read.
let accruedState: { raw?: bigint; decimals?: number; loading: boolean; error?: string } = {
  raw: 12340000n,
  decimals: 6,
  loading: false,
};
vi.mock("../../app/wallet/useAccruedEarnings", () => ({
  useAccruedEarnings: () => accruedState,
}));

beforeEach(() => {
  writeContractAsyncMock.mockClear();
  writeContractAsyncMock.mockResolvedValue(
    "0xtxhash000000000000000000000000000000000000000000000000000000000000",
  );
  accountState = { isConnected: true, address: "0xabc" };
  chainIdState = 5042002;
  accruedState = { raw: 12340000n, decimals: 6, loading: false };
});

function recordedCalls(): { address: string; functionName: string; args: readonly unknown[] }[] {
  return writeContractAsyncMock.mock.calls.map(
    (c) => c[0] as { address: string; functionName: string; args: readonly unknown[] },
  );
}

describe("EarningsWithdrawCard (accrued read + confirm-gated escrow.withdraw reuse)", () => {
  it("renders the accrued withdrawable balance mono via UsdcAmount", async () => {
    const { EarningsWithdrawCard } = await import(
      "../../app/components/dashboard/EarningsWithdrawCard"
    );
    render(React.createElement(EarningsWithdrawCard, { address: "0xabc", decimals: 6 }));
    // 12340000 base units @ 6dp -> $12.34
    expect(screen.getByTestId("earnings-accrued-amount").textContent).toContain("$12.34");
    expect(screen.getAllByTestId("usdc-amount").length).toBeGreaterThan(0);
  });

  it("is confirm-gated: submit opens the modal, no tx until confirm is clicked", async () => {
    const { EarningsWithdrawCard } = await import(
      "../../app/components/dashboard/EarningsWithdrawCard"
    );
    render(React.createElement(EarningsWithdrawCard, { address: "0xabc", decimals: 6 }));

    const input = screen.getByTestId("earnings-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "2.5" } });
    });
    await act(async () => {
      screen.getByTestId("earnings-withdraw-submit").click();
    });
    // OUTFLOW: no tx yet - the confirm modal must gate it.
    expect(writeContractAsyncMock).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId("earnings-confirm");
    await act(async () => {
      confirm.click();
    });

    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    // REUSES the existing escrow.withdraw flow: withdraw(amount) on PAYMENT_ESCROW, the
    // base-unit amount via parseUnits with the RUNTIME decimals (no literal).
    expect(calls[0]!.address).toBe(PAYMENT_ESCROW);
    expect(calls[0]!.functionName).toBe("withdraw");
    expect(calls[0]!.args[0]).toBe(parseUnits("2.5", 6)); // 2500000n
  });

  it("max sets the input to the full accrued balance (formatUnits with runtime decimals)", async () => {
    const { EarningsWithdrawCard } = await import(
      "../../app/components/dashboard/EarningsWithdrawCard"
    );
    render(React.createElement(EarningsWithdrawCard, { address: "0xabc", decimals: 6 }));
    await act(async () => {
      screen.getByTestId("earnings-max").click();
    });
    const input = screen.getByTestId("earnings-amount-input") as HTMLInputElement;
    expect(input.value).toBe("12.34"); // 12340000n @ 6dp
  });

  it("disables submit and flags when the amount exceeds the accrued balance", async () => {
    const { EarningsWithdrawCard } = await import(
      "../../app/components/dashboard/EarningsWithdrawCard"
    );
    render(React.createElement(EarningsWithdrawCard, { address: "0xabc", decimals: 6 }));
    const input = screen.getByTestId("earnings-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "20" } }); // > 12.34 accrued
    });
    expect((screen.getByTestId("earnings-withdraw-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("earnings-over-balance")).toBeInTheDocument();
  });

  it("disables submit when disconnected", async () => {
    accountState = { isConnected: false };
    const { EarningsWithdrawCard } = await import(
      "../../app/components/dashboard/EarningsWithdrawCard"
    );
    render(React.createElement(EarningsWithdrawCard, { address: undefined, decimals: 6 }));
    const input = screen.getByTestId("earnings-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect((screen.getByTestId("earnings-withdraw-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("earnings-disconnected")).toBeInTheDocument();
  });
});

describe("EarningsWithdrawCard render path carries no money literal (T-06-DECIMALS)", () => {
  it("carries no 5042002 / decimals money literal in the card + its hook", () => {
    const RENDER_PATH = [
      "../../app/components/dashboard/EarningsWithdrawCard.tsx",
      "../../app/wallet/useAccruedEarnings.ts",
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
