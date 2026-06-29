// usePayoutHistory.ts - read an address's on-chain PaymentEscrow.Withdrawn events
// (the creator's money OUT) THROUGH readWithdrawals from @utter/chain, so the runtime
// decimals() read is structurally unavoidable (CHAIN-03 / T-06-DECIMALS). This mirrors
// useAccruedEarnings exactly: the reader is injectable (defaulting to readWithdrawals
// over an Arc public client) so component tests drive it deterministically without a
// chain; the cancel-guarded effect re-reads on address/refreshToken changes; the hook
// holds base-unit records + the runtime decimals and the UI formats via UsdcAmount.
// There is NO 6/1e6 money literal here.
//
// Like the sibling read hooks (useAccruedEarnings), this bypasses the StudioDataAdapter
// by design: withdrawals are a direct client-side chain read, not an adapter projection.
// In fixture mode the default reader is never invoked with a connected wallet, so the
// withdrawals group renders empty/loading - the documented client-hook fixture gap.
import * as React from "react";
import {
  readWithdrawals,
  createArcPublicClient,
  type WithdrawalRecord,
  type WithdrawalHistory,
} from "@utter/chain";

/** The payout-history read result: the withdrawal records + the runtime decimals. */
export interface PayoutHistoryState {
  /** The withdrawal records (newest-first), or undefined before the first read. */
  records?: WithdrawalRecord[];
  /** Decimals read from the contract at runtime, or undefined before the first read. */
  decimals?: number;
  /** True while a read is in flight. */
  loading: boolean;
  /** The error message if the last read failed. */
  error?: string;
}

/** A reader that resolves an address's withdrawal history (records + runtime decimals). */
export type PayoutHistoryReader = (address: string) => Promise<WithdrawalHistory>;

/**
 * The default reader: build an Arc public client and call readWithdrawals, which reads
 * decimals() at runtime (never a literal) and the account's Withdrawn logs. Only invoked
 * in the browser path; tests inject a deterministic reader instead.
 */
const defaultReader: PayoutHistoryReader = async (address) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readWithdrawals(client, address as `0x${string}`);
};

export interface UsePayoutHistoryOptions {
  /** The address to read, or undefined when no wallet is connected. */
  address?: string;
  /** Injectable reader (defaults to readWithdrawals over a chain public client). */
  reader?: PayoutHistoryReader;
  /**
   * A monotonic token the caller bumps to force a re-read (e.g. after a withdraw confirms).
   * Changing it re-runs the read for the same address; it carries no money value and never
   * scales an amount.
   */
  refreshToken?: number;
}

/**
 * Read the on-chain withdrawal history for `address` - the creator's real Withdrawn
 * events (money OUT). Returns base-unit records + runtime decimals (no literal); the UI
 * renders each amount via UsdcAmount. Re-reads when the address or `refreshToken` changes.
 */
export function usePayoutHistory({
  address,
  reader = defaultReader,
  refreshToken,
}: UsePayoutHistoryOptions): PayoutHistoryState {
  const [state, setState] = React.useState<PayoutHistoryState>({ loading: false });

  React.useEffect(() => {
    if (!address) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    reader(address)
      .then((history) => {
        if (cancelled) return;
        setState({ records: history.records, decimals: history.decimals, loading: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ loading: false, error: e instanceof Error ? e.message : "read failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, reader, refreshToken]);

  return state;
}
