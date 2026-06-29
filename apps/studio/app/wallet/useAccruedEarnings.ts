// useAccruedEarnings.ts - read an address's ACCRUED escrow balance (the creator's
// withdrawable internal balance, PaymentEscrow.balanceOf) THROUGH readEscrowBalance from
// @utter/chain, so the runtime decimals() read is structurally unavoidable (CHAIN-03 /
// T-06-DECIMALS). This is DISTINCT from useEscrowBalance, which reads the wallet's USDC
// token balance: this hook reads what escrow.withdraw pays out. The hook holds base units
// + the runtime decimals; the UI formats via UsdcAmount. There is NO 6/1e6 literal here.
//
// The reader is injectable (defaulting to readEscrowBalance over a chain public client) so
// component tests drive it deterministically without a chain - mirroring useEscrowBalance.
// The default reader lazily builds an Arc public client (createArcPublicClient) only when
// actually invoked in the browser.
import * as React from "react";
import {
  readEscrowBalance,
  createArcPublicClient,
  type UsdcBalance as ChainUsdcBalance,
} from "@utter/chain";

/** The accrued-earnings read result: raw base units + the runtime decimals. */
export interface AccruedEarningsState {
  /** Raw on-chain accrued balance in base units (bigint), or undefined before the first read. */
  raw?: bigint;
  /** Decimals read from the contract at runtime, or undefined before the first read. */
  decimals?: number;
  /** True while a read is in flight. */
  loading: boolean;
  /** The error message if the last read failed. */
  error?: string;
}

/** A reader that resolves an address's accrued escrow balance (base units + runtime decimals). */
export type AccruedEarningsReader = (address: string) => Promise<ChainUsdcBalance>;

/**
 * The default reader: build an Arc public client and call readEscrowBalance, which reads
 * decimals() at runtime (never a literal) and PaymentEscrow.balanceOf for the account.
 * Only invoked in the browser path; tests inject a deterministic reader instead.
 */
const defaultReader: AccruedEarningsReader = async (address) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readEscrowBalance(client, address as `0x${string}`);
};

export interface UseAccruedEarningsOptions {
  /** The address to read, or undefined when no wallet is connected. */
  address?: string;
  /** Injectable reader (defaults to readEscrowBalance over a chain public client). */
  reader?: AccruedEarningsReader;
  /**
   * A monotonic token the caller bumps to force a re-read (e.g. after a withdraw confirms).
   * Changing it re-runs the read for the same address; it carries no money value and never
   * scales an amount.
   */
  refreshToken?: number;
}

/**
 * Read the ACCRUED escrow balance for `address` - the creator's withdrawable internal
 * balance (PaymentEscrow.balanceOf). Returns base units + runtime decimals (no literal);
 * the UI renders the amount via UsdcAmount. Re-reads when the address or `refreshToken`
 * changes.
 */
export function useAccruedEarnings({
  address,
  reader = defaultReader,
  refreshToken,
}: UseAccruedEarningsOptions): AccruedEarningsState {
  const [state, setState] = React.useState<AccruedEarningsState>({ loading: false });

  React.useEffect(() => {
    if (!address) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    reader(address)
      .then((bal) => {
        if (cancelled) return;
        setState({ raw: bal.raw, decimals: bal.decimals, loading: false });
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
