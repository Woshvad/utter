// useBondWithdraw.ts - the client-side, browser-wallet BOND RECLAIM flow out of the
// StakingVault (Payout, T59). The bond owner's own connected wallet signs the two txs via
// wagmi useWriteContract - NO server adapter, NO facilitator, NO private key. It mirrors
// useWithdraw, EXCEPT the two bond txs carry a bytes32 resourceId, NOT an amount: there is
// NO parseUnits and NO money scaling on this path. The reclaim is two-step:
//
//   request(resourceId) -> StakingVault.requestWithdraw(resourceId): starts the 7-day
//     on-chain COOLDOWN.
//   claim(resourceId)   -> StakingVault.withdraw(resourceId): transfers the bond out after
//     the cooldown has elapsed (bond owner only).
//
// The COOLDOWN / NotBondOwner / WithdrawNotRequested guards live ON-CHAIN (StakingVault);
// the calling UI gates owner-only controls and a cooldown-aware claim purely as a UX
// convenience - a non-owner or too-early tx still reverts on-chain. On a receipt we call
// onDone so the route refetches the bond status.
import * as React from "react";
import { useWriteContract } from "wagmi";
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";
import { useReceiptWait } from "./useReceiptWait.js";

/** The coarse stage of the in-flight bond tx (drives the button + status copy). */
export type BondWithdrawStatus = "idle" | "requesting" | "claiming" | "done" | "error";

export interface UseBondWithdrawOptions {
  /** Called once a request/claim receipt confirms, so the caller can refetch the bond status. */
  onDone?: () => void;
}

export interface UseBondWithdrawResult {
  /** Start the 7-day cooldown: StakingVault.requestWithdraw(resourceId). No amount. */
  request: (resourceId: `0x${string}`) => Promise<void>;
  /** Claim the bond after cooldown: StakingVault.withdraw(resourceId). No amount. */
  claim: (resourceId: `0x${string}`) => Promise<void>;
  /** The coarse stage of the in-flight tx. */
  status: BondWithdrawStatus;
  /** True while a wallet signature is being requested (write submitting). */
  awaitingSignature: boolean;
  /** True while the submitted tx is being mined. */
  confirming: boolean;
  /** The last error message, or undefined. */
  error?: string;
  /** Reset back to idle (clears status/error). */
  reset: () => void;
}

/**
 * Drive the user-signed bond reclaim (request then, after cooldown, claim) from the
 * StakingVault. Both writes carry the bytes32 resourceId, NOT an amount, so there is NO
 * parseUnits / money scaling on this path - the bond amount lives entirely on-chain.
 */
export function useBondWithdraw({ onDone }: UseBondWithdrawOptions = {}): UseBondWithdrawResult {
  const { writeContractAsync, isPending: awaitingSignature } = useWriteContract();
  const { setHash, waitFor, confirming } = useReceiptWait();
  const [status, setStatus] = React.useState<BondWithdrawStatus>("idle");
  const [error, setError] = React.useState<string | undefined>(undefined);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setError(undefined);
    setHash(undefined);
  }, [setHash]);

  const request = React.useCallback(
    async (resourceId: `0x${string}`): Promise<void> => {
      setError(undefined);
      try {
        setStatus("requesting");
        // requestWithdraw takes the bytes32 resourceId only - no amount, no parseUnits.
        const hash = await writeContractAsync({
          address: STAKING_VAULT,
          abi: stakingVaultAbi,
          functionName: "requestWithdraw",
          args: [resourceId],
        });
        setHash(hash);
        await waitFor(hash);

        setStatus("done");
        onDone?.();
      } catch (e: unknown) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "request withdraw failed");
      }
    },
    [writeContractAsync, setHash, waitFor, onDone],
  );

  const claim = React.useCallback(
    async (resourceId: `0x${string}`): Promise<void> => {
      setError(undefined);
      try {
        setStatus("claiming");
        // withdraw takes the bytes32 resourceId only - no amount, no parseUnits. The
        // on-chain COOLDOWN / NotBondOwner guards reject a too-early or non-owner call.
        const hash = await writeContractAsync({
          address: STAKING_VAULT,
          abi: stakingVaultAbi,
          functionName: "withdraw",
          args: [resourceId],
        });
        setHash(hash);
        await waitFor(hash);

        setStatus("done");
        onDone?.();
      } catch (e: unknown) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "claim bond failed");
      }
    },
    [writeContractAsync, setHash, waitFor, onDone],
  );

  return { request, claim, status, awaitingSignature, confirming, error, reset };
}
