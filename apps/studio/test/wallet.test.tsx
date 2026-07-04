// wallet.test.tsx - STU-06 wallet tests (wagmi config + Add Arc Testnet + escrow
// balance + the mono render + providers + the no-literal grep).
//
// wagmi is mocked so the component tests drive useSwitchChain/useAccount
// deterministically with no browser wallet. The escrow read is driven by an injected
// reader (no chain). A source grep asserts no 5042002 / decimals literal in the
// wallet render path (T-06-DECIMALS) and that the config uses arcTestnet + ssr:true.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DepositHistory, WithdrawalHistory } from "@utter/chain";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen, waitFor, act } from "@testing-library/react";
import * as React from "react";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- wagmi mock: deterministic hooks for the component tests ------------------
const switchChainMock = vi.fn(async () => undefined);
let accountState: { address?: string; connector?: { getProvider?: () => Promise<unknown> } } = {};

vi.mock("wagmi", () => ({
  useSwitchChain: () => ({ switchChain: switchChainMock, isPending: false }),
  useAccount: () => accountState,
  // WagmiProvider/createConfig/http are imported by config.ts/root.tsx; provide light stubs.
  WagmiProvider: ({ children }: { children: React.ReactNode }) => children,
  createConfig: (cfg: unknown) => cfg,
  http: () => ({ type: "http" }),
}));

vi.mock("wagmi/connectors", () => ({
  injected: () => ({ type: "injected" }),
  walletConnect: (opts: { projectId: string }) => ({ type: "walletConnect", id: "walletConnect", ...opts }),
}));

beforeEach(() => {
  switchChainMock.mockClear();
  accountState = {};
});

describe("wagmi config (arcTestnet, ssr:true)", () => {
  it("creates the config on the @utter/chain arcTestnet with ssr:true", async () => {
    const { wagmiConfig } = await import("../app/wallet/config");
    const { arcTestnet } = await import("@utter/chain");
    // the mocked createConfig returns the raw config object
    const cfg = wagmiConfig as unknown as {
      chains: { id: number }[];
      ssr: boolean;
      transports: Record<number, unknown>;
    };
    expect(cfg.chains[0]!.id).toBe(arcTestnet.id);
    expect(cfg.ssr).toBe(true);
    expect(Object.keys(cfg.transports)).toContain(String(arcTestnet.id));
  });
});

describe("resolveConnectors (walletConnect gated on projectId)", () => {
  it("returns injected only when no projectId is configured", async () => {
    const { resolveConnectors } = await import("../app/wallet/config");
    const none = resolveConnectors(undefined) as unknown as Array<{ type: string }>;
    const empty = resolveConnectors("") as unknown as Array<{ type: string }>;
    const blank = resolveConnectors("   ") as unknown as Array<{ type: string }>;
    expect(none).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(blank).toHaveLength(1);
    expect(none[0]!.type).toBe("injected");
  });

  it("adds the walletConnect connector when a non-empty projectId is given", async () => {
    const { resolveConnectors } = await import("../app/wallet/config");
    const connectors = resolveConnectors("test-project-id") as unknown as Array<{
      type: string;
      id?: string;
      projectId?: string;
    }>;
    expect(connectors).toHaveLength(2);
    expect(connectors[0]!.type).toBe("injected");
    const wc = connectors[1]!;
    expect(wc.type).toBe("walletConnect");
    expect(wc.id).toBe("walletConnect");
    expect(wc.projectId).toBe("test-project-id");
  });
});

describe("AddArcTestnet (chainId + metadata from arcTestnet)", () => {
  it("switches to the arcTestnet chain id on click (no literal id)", async () => {
    const { AddArcTestnet } = await import("../app/wallet/AddArcTestnet");
    const { arcTestnet } = await import("@utter/chain");
    render(React.createElement(AddArcTestnet, {}));
    const btn = screen.getByTestId("add-arc-testnet");
    await act(async () => {
      btn.click();
    });
    await waitFor(() => expect(switchChainMock).toHaveBeenCalled());
    expect(switchChainMock).toHaveBeenCalledWith({ chainId: arcTestnet.id });
  });

  it("falls back to a raw wallet_addEthereumChain request when switchChain throws", async () => {
    switchChainMock.mockRejectedValueOnce(new Error("unknown chain"));
    const requestMock = vi.fn(
      async (_args: { method: string; params?: unknown[] }): Promise<unknown> => undefined,
    );
    const { AddArcTestnet } = await import("../app/wallet/AddArcTestnet");
    const { arcTestnet } = await import("@utter/chain");
    render(
      React.createElement(AddArcTestnet, {
        provider: { request: requestMock },
      }),
    );
    await act(async () => {
      screen.getByTestId("add-arc-testnet").click();
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const call = requestMock.mock.calls[0]![0] as {
      method: string;
      params: { chainId: string }[];
    };
    expect(call.method).toBe("wallet_addEthereumChain");
    // chainId hex is derived from arcTestnet.id (not a hand-written literal)
    expect(call.params[0]!.chainId).toBe(`0x${arcTestnet.id.toString(16)}`);
  });
});

describe("useEscrowBalance (readUsdcBalance, runtime decimals)", () => {
  it("reads through the injected reader and exposes base units + runtime decimals", async () => {
    const { useEscrowBalance } = await import("../app/wallet/useEscrowBalance");
    const reader = vi.fn(async () => ({ raw: 25000000n, decimals: 6, formatted: "25" }));

    let snapshot: ReturnType<typeof useEscrowBalance> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useEscrowBalance({ address: "0x1111111111111111111111111111111111111111", reader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.raw).toBe(25000000n));
    expect(snapshot?.decimals).toBe(6);
    expect(reader).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
  });
});

describe("useAccruedEarnings (readEscrowBalance / PaymentEscrow.balanceOf, runtime decimals)", () => {
  it("reads through the injected reader and exposes base units + runtime decimals + refresh", async () => {
    const { useAccruedEarnings } = await import("../app/wallet/useAccruedEarnings");
    // The injected reader stands in for readEscrowBalance (PaymentEscrow.balanceOf): a
    // DISTINCT accrued value from the wallet USDC balance, base units + runtime decimals.
    const reader = vi.fn(async () => ({ raw: 12340000n, decimals: 6, formatted: "12.34" }));

    let snapshot: ReturnType<typeof useAccruedEarnings> | undefined;
    let renderRefreshToken = 0;
    function Probe(): React.ReactElement {
      snapshot = useAccruedEarnings({
        address: "0x1111111111111111111111111111111111111111",
        reader,
        refreshToken: renderRefreshToken,
      });
      return React.createElement("div");
    }
    const { rerender } = render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.raw).toBe(12340000n));
    expect(snapshot?.decimals).toBe(6);
    expect(snapshot?.loading).toBe(false);
    expect(snapshot?.error).toBeUndefined();
    expect(reader).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");

    // Bumping refreshToken re-runs the read (the withdraw-then-refresh path).
    renderRefreshToken = 1;
    await act(async () => {
      rerender(React.createElement(Probe));
    });
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
  });

  it("surfaces the error message when the reader rejects", async () => {
    const { useAccruedEarnings } = await import("../app/wallet/useAccruedEarnings");
    const reader = vi.fn(async () => {
      throw new Error("escrow read failed");
    });
    let snapshot: ReturnType<typeof useAccruedEarnings> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useAccruedEarnings({
        address: "0x1111111111111111111111111111111111111111",
        reader,
      });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.error).toBe("escrow read failed"));
    expect(snapshot?.loading).toBe(false);
  });

  it("is a no-op (loading:false) when no address is connected", async () => {
    const { useAccruedEarnings } = await import("../app/wallet/useAccruedEarnings");
    const reader = vi.fn(async () => ({ raw: 12340000n, decimals: 6, formatted: "12.34" }));
    let snapshot: ReturnType<typeof useAccruedEarnings> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useAccruedEarnings({ address: undefined, reader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.loading).toBe(false));
    expect(snapshot?.raw).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("useWalletTransactions (merged Deposited + Withdrawn feed, newest-first)", () => {
  it("merges deposits (in) + withdrawals (out) newest-first with runtime decimals", async () => {
    const { useWalletTransactions } = await import("../app/wallet/useWalletTransactions");
    // Two deposits (blocks 30, 10) + one withdrawal (block 20). The merged feed must be
    // newest-first by blockNumber, each row tagged with its direction.
    const depositsReader = vi.fn(async (): Promise<DepositHistory> => ({
      records: [
        { tx: "0xdep30", amount: 5_000_000n, blockNumber: 30n },
        { tx: "0xdep10", amount: 1_000_000n, blockNumber: 10n },
      ],
      decimals: 6,
    }));
    const withdrawalsReader = vi.fn(async (): Promise<WithdrawalHistory> => ({
      records: [{ tx: "0xwd20", amount: 2_000_000n, blockNumber: 20n }],
      decimals: 6,
    }));

    let snapshot: ReturnType<typeof useWalletTransactions> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useWalletTransactions({
        address: "0x1111111111111111111111111111111111111111",
        depositsReader,
        withdrawalsReader,
      });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.records?.length).toBe(3));
    expect(snapshot?.records?.map((r) => [r.dir, r.blockNumber])).toEqual([
      ["in", 30n],
      ["out", 20n],
      ["in", 10n],
    ]);
    expect(snapshot?.decimals).toBe(6);
    expect(snapshot?.loading).toBe(false);
    expect(depositsReader).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
    expect(withdrawalsReader).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
  });

  it("is a no-op (loading:false, no records) when no address is connected", async () => {
    const { useWalletTransactions } = await import("../app/wallet/useWalletTransactions");
    const depositsReader = vi.fn(async () => ({ records: [], decimals: 6 }));
    const withdrawalsReader = vi.fn(async () => ({ records: [], decimals: 6 }));
    let snapshot: ReturnType<typeof useWalletTransactions> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useWalletTransactions({ address: undefined, depositsReader, withdrawalsReader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.loading).toBe(false));
    expect(snapshot?.records).toBeUndefined();
    expect(depositsReader).not.toHaveBeenCalled();
    expect(withdrawalsReader).not.toHaveBeenCalled();
  });

  it("surfaces the error message when a reader rejects", async () => {
    const { useWalletTransactions } = await import("../app/wallet/useWalletTransactions");
    const depositsReader = vi.fn(async () => ({ records: [], decimals: 6 }));
    const withdrawalsReader = vi.fn(async () => {
      throw new Error("logs read failed");
    });
    let snapshot: ReturnType<typeof useWalletTransactions> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useWalletTransactions({
        address: "0x1111111111111111111111111111111111111111",
        depositsReader,
        withdrawalsReader,
      });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.error).toBe("logs read failed"));
    expect(snapshot?.loading).toBe(false);
  });
});

describe("EscrowBalanceWidget (read-only comp card: 52px mono balance + pill + chain)", () => {
  it("renders the balance mono via UsdcAmount, a no-copy address pill and the arc testnet label", async () => {
    const { EscrowBalanceWidget } = await import("../app/components/wallet/EscrowBalanceWidget");
    render(
      React.createElement(EscrowBalanceWidget, {
        address: "0x4f2a000000000000000000000000000000000091c0",
        baseUnits: 25000000n,
        decimals: 6,
      }),
    );
    // mono balance: 25000000 base units @ 6dp -> $25 (trailing zeros trimmed)
    const amounts = screen.getAllByTestId("usdc-amount");
    expect(amounts.length).toBeGreaterThan(0);
    expect(screen.getByTestId("escrow-balance-amount").textContent).toContain("$25");

    // comp escrow card: a plain (no-copy) address pill + the "arc testnet" chain label.
    expect(screen.getByTestId("address-pill")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy address/i })).toBeNull();
    expect(screen.getByText("arc testnet")).toBeTruthy();

    // the read-only card carries NO move-money controls (those live in the deposit card)
    expect(screen.queryByTestId("escrow-withdraw")).toBeNull();
    expect(screen.queryByTestId("escrow-deposit")).toBeNull();
  });
});

describe("WalletPill (yellow escrow figure, comp pill)", () => {
  it("renders the escrow mono figure when connected (comp shows only the value)", async () => {
    const { WalletPill } = await import("../app/components/shell/WalletPill");
    render(
      React.createElement(WalletPill, {
        account: "0x1111111111111111111111111111111111111111",
        escrowBaseUnits: 25000000n,
        escrowDecimals: 6,
      }),
    );
    expect(screen.getByTestId("wallet-pill").getAttribute("data-connected")).toBe("true");
    expect(screen.getByTestId("usdc-amount").textContent).toContain("$25");
    // The comp escrow pill shows ONLY the yellow figure - no address/word labels.
    expect(screen.queryByTestId("address-pill")).toBeNull();
  });

  it("renders the neutral disconnected state with no faked figure (SSR-safe)", async () => {
    const { WalletPill } = await import("../app/components/shell/WalletPill");
    render(React.createElement(WalletPill, {}));
    expect(screen.getByTestId("wallet-pill").getAttribute("data-connected")).toBe("false");
    expect(screen.queryByTestId("usdc-amount")).toBeNull();
  });
});

describe("wallet render path + root providers (no literal; providers wired)", () => {
  const RENDER_PATH = [
    "../app/wallet/config.ts",
    "../app/wallet/AddArcTestnet.tsx",
    "../app/wallet/useEscrowBalance.ts",
    "../app/wallet/useAccruedEarnings.ts",
    "../app/wallet/useWalletTransactions.ts",
    "../app/components/wallet/EscrowBalanceWidget.tsx",
    "../app/components/primitives/TxLink.tsx",
    "../app/components/shell/WalletPill.tsx",
    "../app/routes/wallet.tsx",
  ];

  it("carries no 5042002 / decimals money literal in the wallet render path", () => {
    const forbidden = [/5042002/, /1e6/i, /10\s*\*\*\s*6/, /\/\s*1000000/, /\b6n\b/, /\b18n\b/, /BigInt\(\s*6\s*\)/, /BigInt\(\s*18\s*\)/];
    for (const rel of RENDER_PATH) {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const re of forbidden) {
        expect(stripped, `${rel} should carry no literal (${re})`).not.toMatch(re);
      }
    }
  });

  it("wires the WagmiProvider + QueryClientProvider into root.tsx", () => {
    const src = readFileSync(resolve(HERE, "../app/root.tsx"), "utf8");
    expect(src).toContain("WagmiProvider");
    expect(src).toContain("QueryClientProvider");
    expect(src).toContain("wagmiConfig");
  });
});
