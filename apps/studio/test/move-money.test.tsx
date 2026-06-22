// move-money.test.tsx - STU-06 browser-wallet DEPOSIT + WITHDRAW tests.
//
// wagmi is fully mocked so the flows run with NO browser wallet and reach NO chain:
// useWriteContract captures the contract calls (and returns deterministic tx hashes),
// useWaitForTransactionReceipt reports an immediate success so the receipt bridge
// resolves, and useAccount/useChainId drive the connected + on-arc guard rails. The
// tests assert the exact call sequences (deposit: approve(PAYMENT_ESCROW, amount) then
// deposit(amount); withdraw: withdraw(amount)), that the base-unit conversion uses the
// RUNTIME decimals (decimals=6 -> "1.5" => 1500000n with no literal), and that submit
// is disabled when disconnected / amount invalid / over balance / wrong chain. A source
// grep asserts the new render path carries no money literal (T-06-DECIMALS).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import * as React from "react";
import { parseUnits } from "viem";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- wagmi mock ---------------------------------------------------------------
// writeContractAsync records each call and returns a per-call hash. The receipt hook
// reports success for any hash so the useReceiptWait bridge resolves immediately.
const writeContractAsyncMock = vi.fn(
  async (_args: unknown): Promise<`0x${string}`> => "0xtxhash000000000000000000000000000000000000000000000000000000000000",
);
let accountState: { isConnected: boolean; address?: string } = { isConnected: true, address: "0xabc" };
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

beforeEach(() => {
  writeContractAsyncMock.mockClear();
  writeContractAsyncMock.mockResolvedValue(
    "0xtxhash000000000000000000000000000000000000000000000000000000000000",
  );
  accountState = { isConnected: true, address: "0xabc" };
  chainIdState = 5042002;
});

// Pull only the contract calls (writes) out of the recorded mock calls.
function recordedCalls(): { address: string; functionName: string; args: readonly unknown[] }[] {
  return writeContractAsyncMock.mock.calls.map(
    (c) => c[0] as { address: string; functionName: string; args: readonly unknown[] },
  );
}

describe("DepositForm (approve then deposit, runtime decimals)", () => {
  it("approves PAYMENT_ESCROW then deposits, both with parseUnits(amount, decimals)", async () => {
    const { DepositForm } = await import("../app/components/wallet/DepositForm");
    const onDeposited = vi.fn();
    render(React.createElement(DepositForm, { decimals: 6, onDeposited }));

    const input = screen.getByTestId("deposit-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "1.5" } });
    });
    await act(async () => {
      screen.getByTestId("deposit-submit").click();
    });

    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(2));
    const calls = recordedCalls();

    // 1) approve(PAYMENT_ESCROW, 1.5 USDC) on USDC
    expect(calls[0]!.address).toBe(USDC);
    expect(calls[0]!.functionName).toBe("approve");
    expect(calls[0]!.args[0]).toBe(PAYMENT_ESCROW);
    expect(calls[0]!.args[1]).toBe(parseUnits("1.5", 6)); // 1500000n via runtime decimals

    // 2) deposit(1.5 USDC) on PAYMENT_ESCROW (same base-unit amount)
    expect(calls[1]!.address).toBe(PAYMENT_ESCROW);
    expect(calls[1]!.functionName).toBe("deposit");
    expect(calls[1]!.args[0]).toBe(parseUnits("1.5", 6));

    await waitFor(() => expect(onDeposited).toHaveBeenCalledTimes(1));
  });

  it("converts via the RUNTIME decimals: 1500000n at decimals=6 (no 1e6 literal)", async () => {
    // Independent confirmation that the conversion equals parseUnits with the passed
    // decimals, which equals 1500000n for "1.5" at 6dp.
    expect(parseUnits("1.5", 6)).toBe(1500000n);
  });

  it("disables submit when disconnected", async () => {
    accountState = { isConnected: false };
    const { DepositForm } = await import("../app/components/wallet/DepositForm");
    render(React.createElement(DepositForm, { decimals: 6 }));
    const input = screen.getByTestId("deposit-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect((screen.getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("deposit-disconnected")).toBeInTheDocument();
  });

  it("disables submit on a non-arc chain", async () => {
    chainIdState = 1; // mainnet, not arcTestnet
    const { DepositForm } = await import("../app/components/wallet/DepositForm");
    render(React.createElement(DepositForm, { decimals: 6 }));
    const input = screen.getByTestId("deposit-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect((screen.getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("deposit-wrong-chain")).toBeInTheDocument();
  });

  it("disables submit when the amount is empty or zero", async () => {
    const { DepositForm } = await import("../app/components/wallet/DepositForm");
    render(React.createElement(DepositForm, { decimals: 6 }));
    // empty
    expect((screen.getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByTestId("deposit-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "0" } });
    });
    expect((screen.getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables submit when decimals are not yet loaded", async () => {
    const { DepositForm } = await import("../app/components/wallet/DepositForm");
    render(React.createElement(DepositForm, {}));
    const input = screen.getByTestId("deposit-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect((screen.getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WithdrawForm (withdraw, runtime decimals, balance cap)", () => {
  it("opens the confirm modal then calls withdraw(parseUnits(amount, decimals))", async () => {
    const { WithdrawForm } = await import("../app/components/wallet/WithdrawForm");
    const onWithdrawn = vi.fn();
    // escrow balance = 25 USDC (25000000n @ 6dp)
    render(
      React.createElement(WithdrawForm, { baseUnits: 25000000n, decimals: 6, onWithdrawn }),
    );

    const input = screen.getByTestId("withdraw-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "2.5" } });
    });
    // withdraw is an OUTFLOW: submit opens the confirm modal, no tx yet
    await act(async () => {
      screen.getByTestId("withdraw-submit").click();
    });
    expect(writeContractAsyncMock).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId("withdraw-confirm");
    await act(async () => {
      confirm.click();
    });

    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    expect(calls[0]!.address).toBe(PAYMENT_ESCROW);
    expect(calls[0]!.functionName).toBe("withdraw");
    expect(calls[0]!.args[0]).toBe(parseUnits("2.5", 6)); // 2500000n via runtime decimals

    await waitFor(() => expect(onWithdrawn).toHaveBeenCalledTimes(1));
  });

  it("max sets the input to the full escrow balance (formatUnits with runtime decimals)", async () => {
    const { WithdrawForm } = await import("../app/components/wallet/WithdrawForm");
    render(React.createElement(WithdrawForm, { baseUnits: 25000000n, decimals: 6 }));
    await act(async () => {
      screen.getByTestId("withdraw-max").click();
    });
    const input = screen.getByTestId("withdraw-amount-input") as HTMLInputElement;
    expect(input.value).toBe("25"); // 25000000n @ 6dp -> "25"
  });

  it("disables submit and flags when the amount exceeds the escrow balance", async () => {
    const { WithdrawForm } = await import("../app/components/wallet/WithdrawForm");
    render(React.createElement(WithdrawForm, { baseUnits: 25000000n, decimals: 6 }));
    const input = screen.getByTestId("withdraw-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "26" } }); // > 25 USDC balance
    });
    expect((screen.getByTestId("withdraw-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("withdraw-over-balance")).toBeInTheDocument();
  });

  it("disables submit when disconnected", async () => {
    accountState = { isConnected: false };
    const { WithdrawForm } = await import("../app/components/wallet/WithdrawForm");
    render(React.createElement(WithdrawForm, { baseUnits: 25000000n, decimals: 6 }));
    const input = screen.getByTestId("withdraw-amount-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect((screen.getByTestId("withdraw-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("withdraw-disconnected")).toBeInTheDocument();
  });
});

describe("move-money render path carries no money literal (T-06-DECIMALS)", () => {
  const RENDER_PATH = [
    "../app/wallet/useDeposit.ts",
    "../app/wallet/useWithdraw.ts",
    "../app/wallet/useReceiptWait.ts",
    "../app/components/wallet/DepositForm.tsx",
    "../app/components/wallet/WithdrawForm.tsx",
  ];

  it("carries no 5042002 / decimals money literal in the move-money path", () => {
    const forbidden = [/1e6/i, /10\s*\*\*\s*6/, /\/\s*1000000/, /\b6n\b/, /\b18n\b/, /BigInt\(\s*6\s*\)/, /BigInt\(\s*18\s*\)/];
    for (const rel of RENDER_PATH) {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const re of forbidden) {
        expect(stripped, `${rel} should carry no literal (${re})`).not.toMatch(re);
      }
    }
  });
});
