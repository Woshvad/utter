// useDeposit.ts - the client-side, browser-wallet DEPOSIT flow into PaymentEscrow
// (STU-06 inflow). Every transaction is signed by the user's own connected wallet
// (the injected connector) via wagmi useWriteContract - there is NO server adapter,
// NO facilitator, and NO private key on this path. The deposit is a two-tx sequence:
//
//   1. approve(PAYMENT_ESCROW, amount) on USDC   -> wait for the receipt
//   2. deposit(amount) on PAYMENT_ESCROW         -> wait for the receipt
//
// because PaymentEscrow.deposit pulls USDC via transferFrom, which needs a prior
// allowance. The human amount string ("5.00") is converted to base units with viem
// parseUnits using the RUNTIME decimals (from useEscrowBalance / readUsdcBalance) -
// there is NO 6/1e6 literal here; if decimals is unknown the submit is blocked.
//
// On the final receipt we call onDeposited so the route can refetch the escrow
// balance. The flow surfaces a coarse status (idle | approving | depositing | done |
// error) plus the awaiting-signature signal so the UI can prompt the user clearly.
import * as React from "react";
import { parseUnits } from "viem";
import { useWriteContract } from "wagmi";
import { USDC, PAYMENT_ESCROW, erc20Abi, escrowAbi } from "@utter/chain";
import { useReceiptWait } from "./useReceiptWait.js";

/** The coarse stage of the deposit sequence (drives the button + status copy). */
export type DepositStatus = "idle" | "approving" | "depositing" | "done" | "error";

export interface UseDepositOptions {
  /** Runtime USDC decimals (from useEscrowBalance). Undefined blocks submit. */
  decimals?: number;
  /** Called once the deposit receipt confirms, so the caller can refetch balance. */
  onDeposited?: () => void;
}

export interface UseDepositResult {
  /** Run the approve -> deposit sequence for the given human USDC amount. */
  deposit: (humanAmount: string) => Promise<void>;
  /** The coarse stage of the in-flight sequence. */
  status: DepositStatus;
  /** True while a wallet signature is being requested (write submitting). */
  awaitingSignature: boolean;
  /** True while a submitted tx is being mined (either approve or deposit). */
  confirming: boolean;
  /** The base-unit amount of the active/last deposit (for the UI to echo), or undefined. */
  pendingBaseUnits?: bigint;
  /** The last error message, or undefined. */
  error?: string;
  /** Reset back to idle (clears status/error). */
  reset: () => void;
}

/**
 * Drive a user-signed deposit (approve then deposit) into PaymentEscrow. The base-unit
 * conversion is the ONLY scaling and it uses the runtime `decimals` via viem parseUnits.
 */
export function useDeposit({ decimals, onDeposited }: UseDepositOptions): UseDepositResult {
  const { writeContractAsync, isPending: awaitingSignature } = useWriteContract();
  const { setHash, waitFor, confirming } = useReceiptWait();
  const [status, setStatus] = React.useState<DepositStatus>("idle");
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [pendingBaseUnits, setPendingBaseUnits] = React.useState<bigint | undefined>(undefined);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setError(undefined);
    setPendingBaseUnits(undefined);
    setHash(undefined);
  }, [setHash]);

  const deposit = React.useCallback(
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
        // 1) approve PAYMENT_ESCROW to pull `amount` USDC base units (user signs).
        setStatus("approving");
        const approveHash = await writeContractAsync({
          address: USDC,
          abi: erc20Abi,
          functionName: "approve",
          args: [PAYMENT_ESCROW, amount],
        });
        setHash(approveHash);
        await waitFor(approveHash);

        // 2) deposit `amount` into the escrow internal balance (user signs).
        setStatus("depositing");
        const depositHash = await writeContractAsync({
          address: PAYMENT_ESCROW,
          abi: escrowAbi,
          functionName: "deposit",
          args: [amount],
        });
        setHash(depositHash);
        await waitFor(depositHash);

        setStatus("done");
        onDeposited?.();
      } catch (e: unknown) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "deposit failed");
      }
    },
    [decimals, writeContractAsync, setHash, waitFor, onDeposited],
  );

  return {
    deposit,
    status,
    awaitingSignature,
    confirming,
    pendingBaseUnits,
    error,
    reset,
  };
}
