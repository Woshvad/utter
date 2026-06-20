// live-exact-path.ts - the OPERATOR-GATED live on-chain proof of the exact /
// EIP-3009 FLAT settlement scheme (PAY-08). It is the companion to
// live-money-path.ts (which proves the primary escrow scheme): the buyer signs an
// EIP-3009 TransferWithAuthorization to the deployed PaymentSplitter, the relayer
// submits it (USDC.transferWithAuthorization moves the signed `value` to the
// splitter - FLAT, no gate, no metering, exactly as the facilitator's exact /settle
// branch does), then distribute() flushes the configured creatorBps split. This is
// the genuine on-chain proof; the autonomous suite proves the EIP-3009 domain +
// settle logic against a mocked chain.
//
// Why the LIVE RPC (not a fork): Arc USDC's transfer path hits a blocklist precompile
// a local fork does not implement (RESEARCH Pitfall 4), so the state-changing
// transferWithAuthorization MUST run against the live Arc RPC. Phase 1/2 hit the same wall.
//
// Run (operator):
//   1. Fund the buyer + relayer EOAs with native USDC at https://faucet.circle.com.
//   2. Set TEST_BUYER_PRIVATE_KEY + RELAYER_SIGNER_KEYS in .env.local (gitignored).
//   3. node packages/x402-arc/examples/echo/live-exact-path.ts
//   4. Confirm the printed ArcScan txs show the transfer to the splitter and the
//      Distributed event with the floored 70/30 creator/treasury split.
//
// SECURITY: keys are read ONLY from .env.local and are NEVER logged.
import { config as loadEnv } from "dotenv";
import {
  decodeEventLog,
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  createArcPublicClient,
  createArcWalletClient,
  erc20Abi,
  erc3009Abi,
  splitterAbi,
  USDC,
  PAYMENT_SPLITTER,
} from "@utter/chain";
import { signExactTransfer } from "@utter/x402-arc";

loadEnv({ path: ".env.local" });

// The minimal @utter/chain splitterAbi carries distribute() + the Distributed event
// (all the settle path needs); the config getters are read here via a small inline ABI.
const splitterConfigAbi = [
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "creatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  // PaymentSplitter.sol: creator + treasury are indexed (topics), the cuts are in data.
  {
    type: "event",
    name: "Distributed",
    inputs: [
      { name: "creator", type: "address", indexed: true },
      { name: "treasury", type: "address", indexed: true },
      { name: "toCreator", type: "uint256", indexed: false },
      { name: "toTreasury", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Read a required env var or exit (never logs the value). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `[live-exact-path] missing ${name}. Fund the buyer + relayer at ` +
        `https://faucet.circle.com and set ${name} in .env.local (gitignored).`,
    );
    process.exit(1);
  }
  return value;
}

/** A 0x-prefixed bytes32 random nonce (EIP-3009 nonces are random, not sequential). */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

async function main(): Promise<void> {
  // (0) Keys from .env.local ONLY (never logged). For a single-wallet run the buyer
  // and relayer are the same EOA; the relayer only pays gas + broadcasts.
  const buyerKey = requireEnv("TEST_BUYER_PRIVATE_KEY") as Hex;
  const relayerKey = requireEnv("RELAYER_SIGNER_KEYS").split(/[,\s]+/)[0] as Hex;
  const rpcUrl = process.env.ARC_RPC_URL;

  const publicClient = createArcPublicClient(rpcUrl) as PublicClient;
  const buyerAccount = privateKeyToAccount(buyerKey);
  const buyer: Address = buyerAccount.address;
  const buyerWallet = createArcWalletClient(buyerAccount, rpcUrl);
  const relayerAccount = privateKeyToAccount(relayerKey);
  const relayerWallet = createArcWalletClient(relayerAccount, rpcUrl);

  const chainId = await publicClient.getChainId();
  if (chainId !== arcTestnet.id) {
    console.error(`[live-exact-path] wrong chain ${chainId}, expected ${arcTestnet.id}`);
    process.exit(1);
  }

  // Read USDC decimals at runtime (never hardcode) to derive a human-scaled price.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  // The flat exact price: 0.005 USDC in base units, derived from decimals at runtime.
  const value = (10n ** BigInt(decimals)) / 200n; // 0.005 USDC
  console.log(`[live-exact-path] buyer ${buyer} on Arc Testnet (chainId ${chainId}); flat price ${value} base units`);

  // Read the splitter config so we know the expected split + recipients.
  const [creator, treasury, creatorBps] = (await Promise.all([
    publicClient.readContract({ address: PAYMENT_SPLITTER, abi: splitterConfigAbi, functionName: "creator" }),
    publicClient.readContract({ address: PAYMENT_SPLITTER, abi: splitterConfigAbi, functionName: "treasury" }),
    publicClient.readContract({ address: PAYMENT_SPLITTER, abi: splitterConfigAbi, functionName: "creatorBps" }),
  ])) as [Address, Address, number];
  console.log(`[live-exact-path] splitter creator ${creator} / treasury ${treasury} / creatorBps ${creatorBps}`);

  // (1) Buyer signs the EIP-3009 TransferWithAuthorization to the splitter (USDC/2 domain).
  const nonce = randomNonce();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const signed = await signExactTransfer(buyerWallet, {
    from: buyer,
    to: PAYMENT_SPLITTER,
    value,
    validAfter: 0n,
    validBefore: now + 300n,
    nonce,
  });
  const { r, s, v } = parseSignature(signed.signature);
  if (v === undefined) throw new Error("signature missing v");

  // (2) Relayer submits transferWithAuthorization -> moves `value` from buyer to the splitter.
  const transferTx = await relayerWallet.writeContract({
    address: USDC,
    abi: erc3009Abi,
    functionName: "transferWithAuthorization",
    args: [buyer, PAYMENT_SPLITTER, value, 0n, now + 300n, nonce, Number(v), r, s],
    account: relayerAccount,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: transferTx });
  console.log(`[live-exact-path] transferWithAuthorization confirmed: ${arcTestnet.blockExplorers?.default.url}/tx/${transferTx}`);

  const heldAfterTransfer = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [PAYMENT_SPLITTER],
  })) as bigint;
  if (heldAfterTransfer < value) {
    throw new Error(`splitter holds ${heldAfterTransfer} after transfer, expected >= ${value}`);
  }
  console.log(`[live-exact-path] splitter now holds ${heldAfterTransfer} base units`);

  // (3) distribute() flushes the held balance into the floored creatorBps split.
  const distributeTx = await relayerWallet.writeContract({
    address: PAYMENT_SPLITTER,
    abi: splitterAbi,
    functionName: "distribute",
    args: [],
    account: relayerAccount,
    chain: arcTestnet,
  });
  const distReceipt = await publicClient.waitForTransactionReceipt({ hash: distributeTx });
  console.log(`[live-exact-path] distribute tx: ${arcTestnet.blockExplorers?.default.url}/tx/${distributeTx}`);

  // (4) Read the Distributed event and ASSERT the floored 70/30 split is conserved.
  const distributed = distReceipt.logs
    .filter((l) => l.address.toLowerCase() === PAYMENT_SPLITTER.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: splitterConfigAbi, data: l.data, topics: l.topics }) as {
          eventName: string;
          args: Record<string, unknown>;
        };
      } catch {
        return null;
      }
    })
    .find((d) => d?.eventName === "Distributed");
  if (!distributed) throw new Error("no Distributed event found in the distribute tx");

  const toCreator = distributed.args.toCreator as bigint;
  const toTreasury = distributed.args.toTreasury as bigint;
  const flushed = heldAfterTransfer; // distribute flushes the FULL held balance
  if (toCreator + toTreasury !== flushed) {
    throw new Error(`split ${toCreator}+${toTreasury} != flushed ${flushed}`);
  }
  const expectedCreator = (flushed * BigInt(creatorBps)) / 10000n;
  if (toCreator !== expectedCreator) {
    throw new Error(`creator cut ${toCreator} != expected ${expectedCreator}`);
  }
  console.log(
    `[live-exact-path] OK: flat transfer ${value} settled to splitter; distribute split ` +
      `creator ${toCreator} (${creatorBps} bps) / treasury ${toTreasury} (rest) verified on-chain.`,
  );
}

main().catch((err) => {
  console.error("[live-exact-path] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
