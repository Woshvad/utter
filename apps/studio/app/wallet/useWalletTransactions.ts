// useWalletTransactions.ts - read an address's REAL on-chain escrow transaction feed:
// PaymentEscrow.Deposited (money IN) + PaymentEscrow.Withdrawn (money OUT), merged
// newest-first, THROUGH readDeposits/readWithdrawals from @utter/chain so the runtime
// decimals() read is structurally unavoidable (CHAIN-03 / T-06-DECIMALS). This replaces
// the wallet page's former fixture "sample data" rows with the connected account's real
// escrow deposits and withdrawals.
//
// It mirrors usePayoutHistory exactly: the readers are injectable (defaulting to the
// chain reads over an Arc public client) so component tests drive it deterministically
// without a chain; the cancel-guarded effect re-reads on address/refreshToken changes;
// the hook holds base-unit records + the runtime decimals and the UI formats via
// UsdcAmount. There is NO 6/1e6 money literal here.
//
// Like the sibling read hooks (usePayoutHistory, useAccruedEarnings), this bypasses the
// StudioDataAdapter by design: escrow events are a direct client-side chain read, not an
// adapter projection. In fixture mode the default readers are never invoked with a
// connected wallet, so the feed renders empty - the documented client-hook fixture gap.
import * as React from "react";
import {
  readDeposits,
  readWithdrawals,
  createArcPublicClient,
  type DepositHistory,
  type WithdrawalHistory,
} from "@utter/chain";

/** One row in the merged escrow transaction feed - a deposit (in) or a withdrawal (out). */
export interface WalletTx {
  /** "in" => deposit (money into escrow); "out" => withdrawal (money out). */
  dir: "in" | "out";
  /** The on-chain tx hash (for the ArcScan link). */
  tx: `0x${string}`;
  /** The amount in USDC base units (bigint); formatted at render via UsdcAmount. */
  amount: bigint;
  /** The block number the tx landed in (drives newest-first ordering). */
  blockNumber: bigint;
}

/** The merged transaction feed: the records (newest-first) + the runtime decimals. */
export interface WalletTxState {
  /** The merged deposit+withdrawal records, newest-first, or undefined before the first read. */
  records?: WalletTx[];
  /** Decimals read from USDC at runtime, or undefined before the first read. */
  decimals?: number;
  /** True while a read is in flight. */
  loading: boolean;
  /** The error message if the last read failed. */
  error?: string;
}

/** A reader that resolves an address's deposit history (records + runtime decimals). */
export type DepositsReader = (address: string) => Promise<DepositHistory>;
/** A reader that resolves an address's withdrawal history (records + runtime decimals). */
export type WithdrawalsReader = (address: string) => Promise<WithdrawalHistory>;

/** The default deposits reader: build an Arc public client and call readDeposits (runtime decimals). */
const defaultDepositsReader: DepositsReader = async (address) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readDeposits(client, address as `0x${string}`);
};

/** The default withdrawals reader: build an Arc public client and call readWithdrawals (runtime decimals). */
const defaultWithdrawalsReader: WithdrawalsReader = async (address) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readWithdrawals(client, address as `0x${string}`);
};

export interface UseWalletTransactionsOptions {
  /** The address to read, or undefined when no wallet is connected. */
  address?: string;
  /** Injectable deposits reader (defaults to readDeposits over a chain public client). */
  depositsReader?: DepositsReader;
  /** Injectable withdrawals reader (defaults to readWithdrawals over a chain public client). */
  withdrawalsReader?: WithdrawalsReader;
  /**
   * A monotonic token the caller bumps to force a re-read (e.g. after a deposit/withdraw
   * confirms). Changing it re-runs the read for the same address; it carries no money
   * value and never scales an amount.
   */
  refreshToken?: number;
}

/**
 * Read the connected address's REAL escrow transaction feed - its Deposited (money IN)
 * and Withdrawn (money OUT) events merged newest-first. Returns base-unit records +
 * runtime decimals (no literal); the UI renders each amount via UsdcAmount. Re-reads when
 * the address or `refreshToken` changes. When no wallet is connected the feed is empty
 * (loading:false), which the UI renders as an honest empty state - never fabricated rows.
 */
export function useWalletTransactions({
  address,
  depositsReader = defaultDepositsReader,
  withdrawalsReader = defaultWithdrawalsReader,
  refreshToken,
}: UseWalletTransactionsOptions): WalletTxState {
  const [state, setState] = React.useState<WalletTxState>({ loading: false });

  React.useEffect(() => {
    if (!address) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    Promise.all([depositsReader(address), withdrawalsReader(address)])
      .then(([deposits, withdrawals]) => {
        if (cancelled) return;
        // Merge both event streams into one feed, tagging direction, then sort
        // newest-first by block number (both readers already sort within their kind).
        const merged: WalletTx[] = [
          ...deposits.records.map((r) => ({ dir: "in" as const, tx: r.tx, amount: r.amount, blockNumber: r.blockNumber })),
          ...withdrawals.records.map((r) => ({ dir: "out" as const, tx: r.tx, amount: r.amount, blockNumber: r.blockNumber })),
        ].sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));
        // Both readers read the same USDC decimals(); prefer whichever resolved.
        const decimals = deposits.decimals ?? withdrawals.decimals;
        setState({ records: merged, decimals, loading: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ loading: false, error: e instanceof Error ? e.message : "read failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, depositsReader, withdrawalsReader, refreshToken]);

  return state;
}
