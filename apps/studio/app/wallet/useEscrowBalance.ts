// useEscrowBalance.ts - read an address's escrow USDC balance (STU-06) THROUGH
// readUsdcBalance from @utter/chain, so the runtime decimals() read is structurally
// unavoidable (CHAIN-03 / T-06-DECIMALS). The hook holds base units + the runtime
// decimals; the widget formats via UsdcAmount. There is NO 6/1e6 literal here.
//
// The balance reader is injectable (defaulting to readUsdcBalance over a chain public
// client) so component tests drive it deterministically without a chain - mirroring
// the adapter fixture-default discipline. The default reader lazily builds an Arc
// public client (createArcPublicClient) only when actually invoked in the browser.
import * as React from "react";
import {
  readUsdcBalance,
  createArcPublicClient,
  type UsdcBalance as ChainUsdcBalance,
} from "@utter/chain";

/** The escrow-balance read result: raw base units + the runtime decimals. */
export interface EscrowBalanceState {
  /** Raw on-chain balance in base units (bigint), or undefined before the first read. */
  raw?: bigint;
  /** Decimals read from the contract at runtime, or undefined before the first read. */
  decimals?: number;
  /** True while a read is in flight. */
  loading: boolean;
  /** The error message if the last read failed. */
  error?: string;
}

/** A reader that resolves an address's USDC balance (base units + runtime decimals). */
export type EscrowBalanceReader = (address: string) => Promise<ChainUsdcBalance>;

/**
 * The default reader: build an Arc public client and call readUsdcBalance, which
 * reads decimals() at runtime (never a literal). Only invoked in the browser path;
 * tests inject a deterministic reader instead.
 */
const defaultReader: EscrowBalanceReader = async (address) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readUsdcBalance(client, address as `0x${string}`);
};

export interface UseEscrowBalanceOptions {
  /** The address to read, or undefined when no wallet is connected. */
  address?: string;
  /** Injectable reader (defaults to readUsdcBalance over a chain public client). */
  reader?: EscrowBalanceReader;
}

/**
 * Read the escrow USDC balance for `address`. Returns base units + runtime decimals
 * (no literal); the widget renders the balance mono via UsdcAmount. Re-reads when the
 * address changes.
 */
export function useEscrowBalance({
  address,
  reader = defaultReader,
}: UseEscrowBalanceOptions): EscrowBalanceState {
  const [state, setState] = React.useState<EscrowBalanceState>({ loading: false });

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
  }, [address, reader]);

  return state;
}
