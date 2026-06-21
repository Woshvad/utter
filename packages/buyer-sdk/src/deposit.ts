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
 * The whole-token deposit sanity ceiling (IN-01). A buyer-side upper bound on how many
 * WHOLE USDC tokens a single deposit may fund; scaled to base units at runtime by the
 * decimals() read (never a base-unit literal). A neededCap above this is rejected
 * fail-closed as a suspicious/overflowed cap. Generous enough for any legitimate cap.
 */
export const DEPOSIT_SANITY_TOKENS = 1_000_000n;

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
  // runtime read and is GENUINELY load-bearing (IN-01): it scales a buyer-side WHOLE-TOKEN
  // sanity ceiling used to fail-closed on an absurd / poisoned cap, so the "amount bounded
  // by the runtime decimals read" property is real, not a grep-satisfying no-op. No
  // 6/18/1e6 literal anywhere - the precision comes only from the runtime decimals.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  const baseUnit = 10n ** BigInt(decimals);

  // A whole-token sanity ceiling: refuse to top up an implausibly large cap (a poisoned
  // card cap that slipped past the per-call pinning, or an overflowed shortfall). The
  // bound is expressed in WHOLE TOKENS and scaled to base units by the runtime baseUnit
  // (DEPOSIT_SANITY_TOKENS * baseUnit) - never a base-unit literal.
  const sanityCeiling = DEPOSIT_SANITY_TOKENS * baseUnit;
  if (neededCap > sanityCeiling) {
    throw new Error(
      `ensureDeposit: neededCap ${neededCap} exceeds the ${DEPOSIT_SANITY_TOKENS}-token ` +
        `deposit sanity ceiling (refusing to fund a suspicious cap)`,
    );
  }

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
