// bond-reclaim.test.tsx - the bond reclaim surface (Payout, T59): the useBondStatus read
// hook, the useBondWithdraw request/claim write hooks, and the BondReclaimPanel component.
//
// wagmi is fully mocked so the write flows run with NO browser wallet and reach NO chain:
// useWriteContract captures the contract calls (and returns a deterministic tx hash),
// useWaitForTransactionReceipt reports an immediate success so the useReceiptWait bridge
// resolves, and useAccount drives the owner-gate + connected state. useBondStatus is driven
// by an injected reader (no chain). The two bond writes carry a bytes32 resourceId and NO
// amount, so there is NO parseUnits assertion - the tests assert request calls
// requestWithdraw and claim calls withdraw with the resourceId. The component tests assert
// the owner/cooldown gating (UX only; the on-chain guards are the real boundary): owner sees
// Request when active / Claim when withdrawable, a non-owner sees read-only status, and the
// cooling-down state shows the unlock time and no Claim. A source grep asserts no money
// literal in the bond render path (T-06-DECIMALS).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen, waitFor, act } from "@testing-library/react";
import * as React from "react";
import { STAKING_VAULT } from "@utter/chain";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A valid bytes32-shaped resourceId the writes carry (no amount on this path). */
const RESOURCE_ID = `0x${"a1".repeat(32)}` as const;
/** The connected bond owner address (matches the injected bond owner so the owner gate opens). */
const OWNER = "0x1111111111111111111111111111111111111111";

// --- wagmi mock (mirrors move-money.test.tsx) --------------------------------
const writeContractAsyncMock = vi.fn(
  async (_args: unknown): Promise<`0x${string}`> =>
    "0xtxhash000000000000000000000000000000000000000000000000000000000000",
);
let accountState: { isConnected: boolean; address?: string } = { isConnected: true, address: OWNER };

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
}));

vi.mock("wagmi/connectors", () => ({ injected: () => ({ type: "injected" }) }));

// --- useBondStatus mock for the component tests: a deterministic bond status, no chain --
// The default is the "active" state (posted > 0, cooldownEnds == 0) owned by OWNER. Each
// component test overrides this before importing the panel.
let bondState: {
  posted?: bigint;
  owner?: `0x${string}`;
  cooldownEnds?: bigint;
  decimals?: number;
  loading: boolean;
  error?: string;
} = {
  posted: 5_000_000n,
  owner: OWNER as `0x${string}`,
  cooldownEnds: 0n,
  decimals: 6,
  loading: false,
};
vi.mock("../app/wallet/useBondStatus", () => ({
  useBondStatus: () => bondState,
}));

beforeEach(() => {
  writeContractAsyncMock.mockClear();
  writeContractAsyncMock.mockResolvedValue(
    "0xtxhash000000000000000000000000000000000000000000000000000000000000",
  );
  accountState = { isConnected: true, address: OWNER };
  bondState = {
    posted: 5_000_000n,
    owner: OWNER as `0x${string}`,
    cooldownEnds: 0n,
    decimals: 6,
    loading: false,
  };
});

function recordedCalls(): { address: string; functionName: string; args: readonly unknown[] }[] {
  return writeContractAsyncMock.mock.calls.map(
    (c) => c[0] as { address: string; functionName: string; args: readonly unknown[] },
  );
}

// === useBondStatus (injected reader, runtime decimals) =======================
describe("useBondStatus (readBondStatus, runtime decimals)", () => {
  it("reads through the injected reader and exposes posted/owner/cooldownEnds + runtime decimals", async () => {
    const { useBondStatus } = await vi.importActual<
      typeof import("../app/wallet/useBondStatus")
    >("../app/wallet/useBondStatus");
    // The injected reader stands in for readBondStatus (StakingVault bonds/bondOwner/
    // cooldownEnds): base-unit posted + owner + cooldown + runtime decimals.
    const reader = vi.fn(async () => ({
      amount: 5_000_000n,
      owner: OWNER as `0x${string}`,
      cooldownEnds: 0n,
      decimals: 6,
    }));

    let snapshot: ReturnType<typeof useBondStatus> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useBondStatus({ resourceId: RESOURCE_ID, reader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));

    await waitFor(() => expect(snapshot?.loading).toBe(false));
    expect(reader).toHaveBeenCalledWith(RESOURCE_ID);
    expect(snapshot?.posted).toBe(5_000_000n);
    expect(snapshot?.owner).toBe(OWNER);
    expect(snapshot?.cooldownEnds).toBe(0n);
    expect(snapshot?.decimals).toBe(6);
  });

  it("surfaces the error message when the reader rejects", async () => {
    const { useBondStatus } = await vi.importActual<
      typeof import("../app/wallet/useBondStatus")
    >("../app/wallet/useBondStatus");
    const reader = vi.fn(async () => {
      throw new Error("bond read failed");
    });
    let snapshot: ReturnType<typeof useBondStatus> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useBondStatus({ resourceId: RESOURCE_ID, reader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(snapshot?.error).toBe("bond read failed"));
  });

  it("is a no-op (loading:false) when no resourceId is given", async () => {
    const { useBondStatus } = await vi.importActual<
      typeof import("../app/wallet/useBondStatus")
    >("../app/wallet/useBondStatus");
    const reader = vi.fn(async () => ({
      amount: 5_000_000n,
      owner: OWNER as `0x${string}`,
      cooldownEnds: 0n,
      decimals: 6,
    }));
    let snapshot: ReturnType<typeof useBondStatus> | undefined;
    function Probe(): React.ReactElement {
      snapshot = useBondStatus({ resourceId: undefined, reader });
      return React.createElement("div");
    }
    render(React.createElement(Probe));
    expect(snapshot?.loading).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });
});

// === useBondWithdraw (request -> requestWithdraw, claim -> withdraw, resourceId, no amount)
// The writes are driven through a small harness component (a button per action) so the
// fire-and-forget + receipt-bridge re-render flow matches the production usage (mirrors the
// move-money WithdrawForm test) - awaiting the promise inside act would deadlock on the
// receipt-wait re-render.
function BondWriteHarness({ onDone }: { onDone?: () => void }): React.ReactElement {
  const { request, claim } = useBondWithdrawActual({ onDone });
  return React.createElement(
    "div",
    null,
    React.createElement("button", { "data-testid": "h-request", onClick: () => void request(RESOURCE_ID) }, "req"),
    React.createElement("button", { "data-testid": "h-claim", onClick: () => void claim(RESOURCE_ID) }, "clm"),
  );
}

// The real (un-mocked) useBondWithdraw, resolved once at module load (this module is not
// mocked, so a plain import is the real implementation; bound here for the harness).
let useBondWithdrawActual: typeof import("../app/wallet/useBondWithdraw").useBondWithdraw;

describe("useBondWithdraw (request/claim carry the bytes32 resourceId, no amount)", () => {
  it("request(resourceId) calls StakingVault.requestWithdraw(resourceId)", async () => {
    useBondWithdrawActual = (await import("../app/wallet/useBondWithdraw")).useBondWithdraw;
    const onDone = vi.fn();
    render(React.createElement(BondWriteHarness, { onDone }));

    await act(async () => {
      screen.getByTestId("h-request").click();
    });

    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    expect(calls[0]!.address).toBe(STAKING_VAULT);
    expect(calls[0]!.functionName).toBe("requestWithdraw");
    // The write carries the bytes32 resourceId and NOTHING else - no amount.
    expect(calls[0]!.args).toEqual([RESOURCE_ID]);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("claim(resourceId) calls StakingVault.withdraw(resourceId)", async () => {
    useBondWithdrawActual = (await import("../app/wallet/useBondWithdraw")).useBondWithdraw;
    const onDone = vi.fn();
    render(React.createElement(BondWriteHarness, { onDone }));

    await act(async () => {
      screen.getByTestId("h-claim").click();
    });

    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    expect(calls[0]!.address).toBe(STAKING_VAULT);
    expect(calls[0]!.functionName).toBe("withdraw");
    // The withdraw carries the bytes32 resourceId, NOT an amount (distinct from
    // escrow.withdraw(amount)).
    expect(calls[0]!.args).toEqual([RESOURCE_ID]);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

// === BondReclaimPanel (owner/cooldown gating; the on-chain guards are the real boundary) ===
describe("BondReclaimPanel (owner-gated, cooldown-aware reclaim controls)", () => {
  it("owner + active: renders the posted bond mono and a Request withdraw button", async () => {
    bondState = { posted: 5_000_000n, owner: OWNER as `0x${string}`, cooldownEnds: 0n, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));
    // 5000000 base units @ 6dp -> $5
    expect(screen.getByTestId("bond-posted-amount").textContent).toContain("$5");
    expect(screen.getByTestId("bond-request")).toBeInTheDocument();
    // active state shows no Claim.
    expect(screen.queryByTestId("bond-claim")).toBeNull();
  });

  it("owner + active: clicking Request calls request(resourceId) (no confirm modal)", async () => {
    bondState = { posted: 5_000_000n, owner: OWNER as `0x${string}`, cooldownEnds: 0n, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));
    await act(async () => {
      screen.getByTestId("bond-request").click();
    });
    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    expect(calls[0]!.address).toBe(STAKING_VAULT);
    expect(calls[0]!.functionName).toBe("requestWithdraw");
    expect(calls[0]!.args).toEqual([RESOURCE_ID]);
  });

  it("owner + withdrawable: shows a Claim button that is confirm-gated (no tx until confirm)", async () => {
    // cooldownEnds in the PAST -> withdrawable.
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    bondState = { posted: 5_000_000n, owner: OWNER as `0x${string}`, cooldownEnds: past, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));

    expect(screen.queryByTestId("bond-request")).toBeNull();
    await act(async () => {
      screen.getByTestId("bond-claim").click();
    });
    // OUTFLOW: no tx yet - the confirm modal must gate it.
    expect(writeContractAsyncMock).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId("bond-confirm");
    await act(async () => {
      confirm.click();
    });
    await waitFor(() => expect(writeContractAsyncMock).toHaveBeenCalledTimes(1));
    const calls = recordedCalls();
    expect(calls[0]!.address).toBe(STAKING_VAULT);
    expect(calls[0]!.functionName).toBe("withdraw");
    expect(calls[0]!.args).toEqual([RESOURCE_ID]);
  });

  it("owner + cooling-down: shows the unlock time and no Claim/Request", async () => {
    // cooldownEnds in the FUTURE -> cooling-down.
    const future = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
    bondState = { posted: 5_000_000n, owner: OWNER as `0x${string}`, cooldownEnds: future, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));
    expect(screen.getByTestId("bond-state").textContent).toContain("cooling down");
    expect(screen.queryByTestId("bond-claim")).toBeNull();
    expect(screen.queryByTestId("bond-request")).toBeNull();
  });

  it("non-owner: shows the read-only status with no controls", async () => {
    // A connected wallet that is NOT the bond owner.
    accountState = { isConnected: true, address: "0x2222222222222222222222222222222222222222" };
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    bondState = { posted: 5_000_000n, owner: OWNER as `0x${string}`, cooldownEnds: past, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));
    // The posted amount still renders read-only.
    expect(screen.getByTestId("bond-posted-amount").textContent).toContain("$5");
    // No controls for a non-owner, even when withdrawable on-chain.
    expect(screen.queryByTestId("bond-request")).toBeNull();
    expect(screen.queryByTestId("bond-claim")).toBeNull();
  });

  it("no bond (posted == 0): shows the none state with no controls", async () => {
    bondState = { posted: 0n, owner: "0x0000000000000000000000000000000000000000", cooldownEnds: 0n, decimals: 6, loading: false };
    const { BondReclaimPanel } = await import("../app/components/wallet/BondReclaimPanel");
    render(React.createElement(BondReclaimPanel, { resourceId: RESOURCE_ID, decimals: 6 }));
    expect(screen.getByTestId("bond-state").textContent).toContain("no bond posted");
    expect(screen.queryByTestId("bond-request")).toBeNull();
    expect(screen.queryByTestId("bond-claim")).toBeNull();
  });
});

// === no money literal in the bond render path (T-06-DECIMALS) =================
describe("bond reclaim render path carries no money literal (T-06-DECIMALS)", () => {
  it("carries no decimals money literal in the hooks + the panel", () => {
    const RENDER_PATH = [
      "../app/wallet/useBondStatus.ts",
      "../app/wallet/useBondWithdraw.ts",
      "../app/components/wallet/BondReclaimPanel.tsx",
    ];
    const forbidden = [
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
