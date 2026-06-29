// treasury-sweep.ts - the OPERATOR-GATED live treasury fee sweep (MAINNET section 5).
//
// This spends real testnet USDC: it withdraws the platform treasury's accrued
// PaymentEscrow.balanceOf (the 30 percent cut credited by each settle split) to the
// treasury wallet via escrow.withdraw. It is OPERATOR-GATED exactly like the x402-arc
// live-money-path script: the autonomous suite (payout.test.ts) proves the sweep LOGIC
// against a mock AdminWriter; THIS script broadcasts the genuine on-chain withdraw. It
// is NEVER run in CI.
//
// PULL-PAYMENT: escrow.withdraw is msg.sender-scoped, so this can sweep ONLY the account
// whose key it holds - the treasury. The wallet account address IS the treasury swept.
// Creators self-withdraw their own accrued share via the studio; the operator cannot
// push to a creator. See infrastructure/PAYOUT.md.
//
// SECURITY: the treasury key is read ONLY from .env.local (loaded via node --env-file)
// and is NEVER logged. This script reads the key once, builds the wallet, and discards
// the raw value.
//
// Run (operator, post-merge):
//   1. Set PLATFORM_TREASURY_PRIVATE_KEY in .env.local (gitignored). Optional:
//      ARC_RPC_URL, PAYOUT_MIN_THRESHOLD (base units).
//   2. node --env-file=.env.local <runner> packages/staking/examples/treasury-sweep.ts
//   3. Confirm the printed ArcScan tx shows a Withdrawn event to the treasury wallet.
import {
  arcTestnet,
  createArcPublicClient,
  createArcWalletClientFromKey,
  readEscrowBalance,
} from "@utter/chain";
import { sweepTreasuryPayout } from "../src/payout.js";

/** Read a required env var or exit with an operator-friendly message (never logs the value). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `[treasury-sweep] missing ${name}. Set ${name} in .env.local (gitignored) and run ` +
        `via node --env-file=.env.local. See infrastructure/PAYOUT.md.`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  // (0) The treasury key from .env.local ONLY. Read once, never logged.
  const treasuryKey = requireEnv("PLATFORM_TREASURY_PRIVATE_KEY") as `0x${string}`;
  const rpcUrl = process.env.ARC_RPC_URL;
  const minThreshold = process.env.PAYOUT_MIN_THRESHOLD
    ? BigInt(process.env.PAYOUT_MIN_THRESHOLD.trim())
    : undefined;

  // Build the treasury wallet (the msg.sender for escrow.withdraw) + the read client.
  // The treasury swept is exactly this wallet's account address.
  const wallet = createArcWalletClientFromKey(treasuryKey, rpcUrl);
  const treasury = wallet.account.address;
  const publicClient = createArcPublicClient(rpcUrl);

  // Sanity: confirm we are on Arc Testnet before spending anything (mirror live-money-path).
  const chainId = await publicClient.getChainId();
  if (chainId !== arcTestnet.id) {
    console.error(`[treasury-sweep] wrong chain ${chainId}, expected ${arcTestnet.id} (Arc Testnet)`);
    process.exit(1);
  }
  console.log(`[treasury-sweep] treasury ${treasury} on Arc Testnet (chainId ${chainId})`);

  // Display only: the human accrued amount (readEscrowBalance reads decimals at runtime).
  const balance = await readEscrowBalance(publicClient, treasury);
  console.log(
    `[treasury-sweep] accrued escrow balance: ${balance.formatted} USDC (${balance.raw} base units)`,
  );

  // The sweep: withdraw the full accrued balance (the AdminWriter is the treasury wallet,
  // so msg.sender == treasury and the USDC lands in the treasury wallet).
  const result = await sweepTreasuryPayout(
    { admin: wallet, publicClient },
    { treasury, minThreshold },
  );

  if (result.tx === null) {
    console.log(
      `[treasury-sweep] nothing to sweep (accrued ${result.accrued} base units` +
        `${minThreshold !== undefined ? `, below threshold ${minThreshold}` : ""}).`,
    );
    return;
  }

  console.log(
    `[treasury-sweep] OK: withdrew ${result.withdrawn} base units (accrued ${result.accrued}) ` +
      `to the treasury wallet.`,
  );
  console.log(`[treasury-sweep] ArcScan: ${arcTestnet.blockExplorers?.default.url}/tx/${result.tx}`);
}

main().catch((err) => {
  console.error("[treasury-sweep] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
