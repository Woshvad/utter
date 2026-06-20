// @utter/x402-arc/client - the paying-agent entrypoint (Phase 7 buyer SDK imports
// this subpath WITHOUT pulling in the facilitator). It signs the two payment
// authorizations with Viem `signTypedData` ONLY - never hand-rolled keccak/encode:
//
//   - signDebitAuthorization: the escrow DebitAuthorization (PAY-03) under the
//     LOCKED UtterEscrow/1 domain (verifyingContract = PAYMENT_ESCROW), field
//     order buyer,resourceId,maxAmount,nonce,validBefore - matching
//     PaymentEscrow.sol DEBIT_TYPEHASH byte-for-byte so on-chain recovery == buyer.
//   - signExactTransfer: the EIP-3009 TransferWithAuthorization (PAY-08) under the
//     CONFIRMED Arc USDC domain (USDC/2, verifyingContract = USDC). `exact` is
//     FLAT-only: no gate, no metering; it settles to a PaymentSplitter.
//
// Both addresses are imported from @utter/chain - never re-literal'd here.
import type { Account, Chain, Hex, Transport, WalletClient } from "viem";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";

// Re-export the shared store types the buyer SDK retries against (Wave 0 contract).
export type { ReservationLock, StoredResult } from "./store";

/**
 * The LOCKED DebitAuthorization EIP-712 types array. The field order
 * buyer,resourceId,maxAmount,nonce,validBefore matches PaymentEscrow.sol
 * DEBIT_TYPEHASH; reordering breaks recovery. Exported so tests recover with the
 * exact same types.
 */
export const DEBIT_AUTHORIZATION_TYPES = [
  { name: "buyer", type: "address" },
  { name: "resourceId", type: "bytes32" },
  { name: "maxAmount", type: "uint256" },
  { name: "nonce", type: "bytes32" },
  { name: "validBefore", type: "uint256" },
] as const;

/** The escrow EIP-712 domain (LOCKED): UtterEscrow/1 on Arc, verifying PaymentEscrow. */
export const ESCROW_DOMAIN = {
  name: "UtterEscrow",
  version: "1",
  chainId: 5042002,
  verifyingContract: PAYMENT_ESCROW,
} as const;

/**
 * The EIP-3009 TransferWithAuthorization types array (canonical EIP-3009 field
 * order). Exported so tests recover with the exact same types.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** The Arc USDC EIP-3009 domain (CONFIRMED on-chain): USDC/2, verifying USDC. */
export const USDC_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: 5042002,
  verifyingContract: USDC,
} as const;

/** Any wallet client exposing Viem `signTypedData` (a Viem WalletClient with an account). */
export type SignerWalletClient = WalletClient<Transport, Chain | undefined, Account>;

/** The escrow DebitAuthorization message a buyer signs. */
export interface DebitAuthorizationInput {
  /** The buyer (must equal the signing account for recovery to match). */
  buyer: Hex;
  /** The resource being charged (bytes32). */
  resourceId: Hex;
  /** The signed spend cap in USDC base units (bigint). */
  maxAmount: bigint;
  /** The single-use replay nonce (bytes32) = the idemKey. */
  nonce: Hex;
  /** Unix-seconds expiry (bigint). Must outlive the gate (now + timeout + buffer). */
  validBefore: bigint;
}

/** A signed escrow authorization ready for the X-PAYMENT payload. */
export interface SignedDebitAuthorization {
  /** The authorization message (echoed for encoding + on-chain submission). */
  authorization: DebitAuthorizationInput;
  /** The EIP-712 signature (0x-hex). */
  signature: Hex;
}

/**
 * Sign the escrow DebitAuthorization with Viem under the LOCKED UtterEscrow/1
 * domain. The recovered signer equals `buyer` on-chain (PaymentEscrow._verify).
 */
export async function signDebitAuthorization(
  walletClient: SignerWalletClient,
  message: DebitAuthorizationInput,
): Promise<SignedDebitAuthorization> {
  const signature = await walletClient.signTypedData({
    account: walletClient.account,
    domain: ESCROW_DOMAIN,
    types: { DebitAuthorization: DEBIT_AUTHORIZATION_TYPES },
    primaryType: "DebitAuthorization",
    message,
  });
  return { authorization: message, signature };
}

/** The EIP-3009 TransferWithAuthorization message a buyer signs for the exact path. */
export interface TransferWithAuthorizationInput {
  /** The payer (must equal the signing account). */
  from: Hex;
  /** The recipient (the PaymentSplitter for the flat path). */
  to: Hex;
  /** The exact transfer amount in USDC base units (bigint). */
  value: bigint;
  /** Unix-seconds not-valid-before (bigint; 0 = immediately valid). */
  validAfter: bigint;
  /** Unix-seconds expiry (bigint). */
  validBefore: bigint;
  /** The single-use authorization nonce (bytes32). */
  nonce: Hex;
}

/** A signed exact transfer authorization ready for the facilitator `/settle`. */
export interface SignedExactTransfer {
  /** The authorization message. */
  authorization: TransferWithAuthorizationInput;
  /** The EIP-712 signature (0x-hex). */
  signature: Hex;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization with Viem under the CONFIRMED Arc
 * USDC domain (USDC/2). The recovered signer equals `from`. `exact` is FLAT-only.
 */
export async function signExactTransfer(
  walletClient: SignerWalletClient,
  message: TransferWithAuthorizationInput,
): Promise<SignedExactTransfer> {
  const signature = await walletClient.signTypedData({
    account: walletClient.account,
    domain: USDC_DOMAIN,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: "TransferWithAuthorization",
    message,
  });
  return { authorization: message, signature };
}

/**
 * Compute a `validBefore` that outlives the gate: now + maxTimeoutSeconds +
 * settleBufferSeconds (CONTEXT line 84), so the auth cannot expire between the
 * handler run and the on-chain debit.
 */
export function computeValidBefore(
  maxTimeoutSeconds: number,
  settleBufferSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): bigint {
  return BigInt(nowSeconds + maxTimeoutSeconds + settleBufferSeconds);
}
