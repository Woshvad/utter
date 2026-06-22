// useWithdraw.ts - the client-side, browser-wallet WITHDRAW flow out of PaymentEscrow
// (STU-06 OUTFLOW). The user's own connected wallet signs the single withdraw tx via
// wagmi useWriteContract - NO server adapter, NO facilitator, NO private key. This is
// a single tx (no approve): PaymentEscrow.withdraw(amount) debits the caller's internal
// balanceOf and safeTransfers the USDC back to the caller (an overdraw reverts on the
// 0.8 underflow). The human amount string is converted to base units with viem
// parseUnits using the RUNTIME decimals (no 6/1e6 literal); submit is blocked until
// decimals is known. On the receipt we call onWithdrawn so the route refetches balance.
import * as React from "react";
import { parseUnits } from "viem";
import { useWriteContract } from "wagmi";
import { PAYMENT_ESCROW, escrowAbi } from "@utter/chain";
import { useReceiptWait } from "./useReceiptWait.js";

/** The coarse stage of the withdraw tx (drives the button + status copy). */
export type WithdrawStatus = "idle" | "withdrawing" | "done" | "error";

export interface UseWithdrawOptions {
  /** Runtime USDC decimals (from useEscrowBalance). Undefined blocks submit. */
  decimals?: number;
  /** Called once the withdraw receipt confirms, so the caller can refetch balance. */
  onWithdrawn?: () => void;
}

export interface UseWithdrawResult {
  /** Run withdraw(amount) for the given human USDC amount. */
  withdraw: (humanAmount: string) => Promise<void>;
  /** The coarse stage of the in-flight tx. */
  status: WithdrawStatus;
  /** True while a wallet signature is being requested (write submitting). */
  awaitingSignature: boolean;
  /** True while the submitted withdraw tx is being mined. */
  confirming: boolean;
  /** The base-unit amount of the active/last withdraw (for the UI to echo), or undefined. */
  pendingBaseUnits?: bigint;
  /** The last error message, or undefined. */
  error?: string;
  /** Reset back to idle (clears status/error). */
  reset: () => void;
}

/**
 * Drive a user-signed withdraw from PaymentEscrow. The base-unit conversion is the ONLY
 * scaling and uses the runtime `decimals` via viem parseUnits.
 */
export function useWithdraw({ decimals, onWithdrawn }: UseWithdrawOptions): UseWithdrawResult {
  const { writeContractAsync, isPending: awaitingSignature } = useWriteContract();
  const { setHash, waitFor, confirming } = useReceiptWait();
  const [status, setStatus] = React.useState<WithdrawStatus>("idle");
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [pendingBaseUnits, setPendingBaseUnits] = React.useState<bigint | undefined>(undefined);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setError(undefined);
    setPendingBaseUnits(undefined);
    setHash(undefined);
  }, [setHash]);

  const withdraw = React.useCallback(
    async (humanAmount: string): Promise<void> => {
      if (decimals === undefined) {
        setStatus("error");
        setError("decimals not loaded yet");
        return;
      }
      let amount: bigint;
      try {
        // The ONLY scaling on the path: human string -> base units with RUNTIME decimals.
        amount = parseUnits(humanAmount, decimals);
      } catch {
        setStatus("error");
        setError("invalid amount");
        return;
      }
      if (amount <= 0n) {
        setStatus("error");
        setError("amount must be greater than zero");
        return;
      }

      setError(undefined);
      setPendingBaseUnits(amount);
      try {
        setStatus("withdrawing");
        const withdrawHash = await writeContractAsync({
          address: PAYMENT_ESCROW,
          abi: escrowAbi,
          functionName: "withdraw",
          args: [amount],
        });
        setHash(withdrawHash);
        await waitFor(withdrawHash);

        setStatus("done");
        onWithdrawn?.();
      } catch (e: unknown) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "withdraw failed");
      }
    },
    [decimals, writeContractAsync, setHash, waitFor, onWithdrawn],
  );

  return {
    withdraw,
    status,
    awaitingSignature,
    confirming,
    pendingBaseUnits,
    error,
    reset,
  };
}
