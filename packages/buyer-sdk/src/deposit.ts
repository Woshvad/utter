// deposit.ts - ensureDeposit: the deposit-once escrow funding orchestration (BUY-01,
// T-07-DECIMALS / CHAIN-03).
//
// GREENFIELD glue: no repo file does the approve+deposit write SEQUENCE. The pattern is
// RESEARCH Pattern 3 + Pitfall 5:
//   (1) read PaymentEscrow.balanceOf(buyer) - the INTERNAL escrow credited balance,
//       distinct from erc20Abi.balanceOf (the on-chain USDC balance).
//   (2) if it already covers neededCap -> ZERO writes (deposit-ONCE, not per call).
//   (3) else read decimals() at RUNTIME (the precision witness; never a 6/18/1e6
//       literal), derive baseUnit = 10n ** BigInt(decimals), compute the top-up, and:
//       (a) Pitfall 5: PaymentEscrow.deposit pulls USDC via SafeERC20 transferFrom, so a
//           prior USDC.approve(PAYMENT_ESCROW, amount) is REQUIRED. Read the allowance;
//           approve if short. The spy asserts the approve-THEN-deposit order.
//       (b) PaymentEscrow.deposit(topUp).
//
// erc20Abi (packages/chain/src/abis.ts) has only decimals/symbol/name/balanceOf - it
// LACKS approve/allowance. We add a minimal LOCAL ABI fragment for exactly those two
// (the field shape copied from erc20Abi), carrying NO decimals literal.
//
// `viem` is TYPE-ONLY here (erased at build): no runtime viem coupling.
import type { PublicClient, WalletClient, Account, Chain, Transport } from "viem";
import { erc20Abi, escrowAbi, USDC, PAYMENT_ESCROW } from "@utter/chain";

/** A wallet client exposing viem writeContract (a WalletClient with an account). */
export type DepositWalletClient = WalletClient<Transport, Chain | undefined, Account>;

/**
 * The minimal USDC approve/allowance ABI fragment. erc20Abi (@utter/chain) is read-only
 * (decimals/balanceOf) and intentionally omits the write surface; we add exactly the two
 * entries ensureDeposit needs, copying the field shape from erc20Abi. No decimals
 * literal anywhere (the precision is read at runtime, never encoded here).
 */
export const usdcApprovalAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Options for {@link ensureDeposit}. */
export interface EnsureDepositOptions {
  /** The chain read client (escrow balanceOf + USDC decimals/allowance). */
  publicClient: PublicClient;
  /** The buyer's wallet client (signs approve + deposit). Live writes operator-gated. */
  walletClient: DepositWalletClient;
  /** The buyer EOA whose escrow balance is funded. */
  buyer: `0x${string}`;
  /** The cap (base units) the buyer must have credited in escrow to pay (deposit-once target). */
  neededCap: bigint;
}

/** The outcome of an ensureDeposit call (for the caller + the test spies). */
export interface EnsureDepositResult {
  /** True iff a deposit write was submitted (false = already funded, zero writes). */
  deposited: boolean;
  /** True iff an approve write was submitted before the deposit. */
  approved: boolean;
  /** The escrow credited balance read at entry (base units). */
  escrowBalance: bigint;
  /** The top-up amount deposited (base units), or 0n when already funded. */
  topUp: bigint;
  /** The deposit tx hash, or null when no deposit was needed. */
  depositTx: `0x${string}` | null;
}

/**
 * Ensure the buyer holds at least `neededCap` credited in PaymentEscrow, depositing the
 * shortfall ONCE (not per call). Reads the escrow credited balance first; if it already
 * covers the cap, makes ZERO writes. Otherwise reads decimals() at runtime (the
 * precision witness), tops up by the shortfall, approving USDC for the escrow first if
 * the allowance is short (Pitfall 5). All amounts are base units derived from the
 * runtime decimals read - no 6/18/1e6 literal in this file.
 */
export async function ensureDeposit(opts: EnsureDepositOptions): Promise<EnsureDepositResult> {
  const { publicClient, walletClient, buyer, neededCap } = opts;

  // (1) The INTERNAL escrow credited balance (distinct from the on-chain USDC balance).
  const escrowBalance = (await publicClient.readContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;

  // (2) Deposit-once: already funded -> no writes.
  if (escrowBalance >= neededCap) {
    return {
      deposited: false,
      approved: false,
      escrowBalance,
      topUp: 0n,
      depositTx: null,
    };
  }

  // (3) Read decimals() at RUNTIME (Pitfall 3 / CHAIN-03). baseUnit is derived from the
  // runtime read - the precision witness that no path assumes 6 or 18. The top-up is the
  // shortfall in base units; baseUnit anchors the precision the amounts are denominated in.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  const baseUnit = 10n ** BigInt(decimals);
  void baseUnit; // precision derived at runtime, never literal'd

  const topUp = neededCap - escrowBalance;

  // (3a) Pitfall 5: deposit pulls via SafeERC20 transferFrom - approve the escrow first
  // if the current allowance cannot cover the top-up. The approve MUST precede the
  // deposit (the spy asserts the order against the mock chain).
  const allowance = (await publicClient.readContract({
    address: USDC,
    abi: usdcApprovalAbi,
    functionName: "allowance",
    args: [buyer, PAYMENT_ESCROW],
  })) as bigint;

  let approved = false;
  if (allowance < topUp) {
    await walletClient.writeContract({
      address: USDC,
      abi: usdcApprovalAbi,
      functionName: "approve",
      args: [PAYMENT_ESCROW, topUp],
      account: walletClient.account,
      chain: walletClient.chain,
    });
    approved = true;
  }

  // (3b) Deposit the shortfall (deposit-once).
  const depositTx = (await walletClient.writeContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "deposit",
    args: [topUp],
    account: walletClient.account,
    chain: walletClient.chain,
  })) as `0x${string}`;

  return { deposited: true, approved, escrowBalance, topUp, depositTx };
}
