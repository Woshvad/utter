// useBondStatus.ts - read a resource's on-chain bond status (Payout, T59) THROUGH
// readBondStatus from @utter/chain, so the runtime decimals() read is structurally
// unavoidable (CHAIN-03 / T-06-DECIMALS). This mirrors useAccruedEarnings/useEscrowBalance
// exactly, except it keys off a resourceId (a bytes32 hex) instead of an address: it reads
// the StakingVault bonds(resourceId) amount, the bondOwner(resourceId), and the
// cooldownEnds(resourceId). The hook holds the posted amount in base units + the runtime
// decimals; the UI formats via UsdcAmount and derives can-request / can-claim from owner +
// cooldownEnds + the current time. There is NO 6/1e6 literal here.
//
// The reader is injectable (defaulting to readBondStatus over a chain public client) so
// component tests drive it deterministically without a chain. The default reader lazily
// builds an Arc public client (createArcPublicClient) only when actually invoked.
import * as React from "react";
import {
  readBondStatus,
  createArcPublicClient,
  type BondStatus as ChainBondStatus,
} from "@utter/chain";

/** The bond-status read result: posted base units + owner + cooldownEnds + runtime decimals. */
export interface BondStatusState {
  /** The posted bond in base units (bigint), or undefined before the first read. */
  posted?: bigint;
  /** The bond owner address, or undefined before the first read. */
  owner?: `0x${string}`;
  /** The cooldown end timestamp (0n = no withdraw requested), or undefined before the read. */
  cooldownEnds?: bigint;
  /** Decimals read from the contract at runtime, or undefined before the first read. */
  decimals?: number;
  /** True while a read is in flight. */
  loading: boolean;
  /** The error message if the last read failed. */
  error?: string;
}

/** A reader that resolves a resource's on-chain bond status (amount + owner + cooldown + decimals). */
export type BondStatusReader = (resourceId: `0x${string}`) => Promise<ChainBondStatus>;

/**
 * The default reader: build an Arc public client and call readBondStatus, which reads
 * decimals() at runtime (never a literal) and the StakingVault bonds/bondOwner/cooldownEnds
 * mappings. Only invoked in the browser path; tests inject a deterministic reader instead.
 */
const defaultReader: BondStatusReader = async (resourceId) => {
  const client = createArcPublicClient(
    typeof process !== "undefined" ? process.env.ARC_RPC_URL : undefined,
  );
  return readBondStatus(client, resourceId);
};

export interface UseBondStatusOptions {
  /** The resourceId (bytes32 hex) to read, or undefined when none is selected. */
  resourceId?: `0x${string}`;
  /** Injectable reader (defaults to readBondStatus over a chain public client). */
  reader?: BondStatusReader;
  /**
   * A monotonic token the caller bumps to force a re-read (e.g. after a request/claim
   * confirms). Changing it re-runs the read for the same resourceId; it carries no money
   * value and never scales an amount.
   */
  refreshToken?: number;
}

/**
 * Read the on-chain bond status for `resourceId` - the posted bond amount, the bond owner,
 * and the cooldown end timestamp. Returns base units + runtime decimals (no literal); the
 * UI renders the amount via UsdcAmount and derives the request/claim controls from owner +
 * cooldownEnds + now. Re-reads when the resourceId or `refreshToken` changes.
 */
export function useBondStatus({
  resourceId,
  reader = defaultReader,
  refreshToken,
}: UseBondStatusOptions): BondStatusState {
  const [state, setState] = React.useState<BondStatusState>({ loading: false });

  React.useEffect(() => {
    if (!resourceId) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    reader(resourceId)
      .then((s) => {
        if (cancelled) return;
        setState({
          posted: s.amount,
          owner: s.owner as `0x${string}`,
          cooldownEnds: s.cooldownEnds,
          decimals: s.decimals,
          loading: false,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ loading: false, error: e instanceof Error ? e.message : "read failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [resourceId, reader, refreshToken]);

  return state;
}
