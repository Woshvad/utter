// live-money-path.ts - the OPERATOR-GATED live on-chain money-path E2E (PAY-12).
//
// This is the genuine on-chain proof for the phase: it spends real testnet USDC and
// broadcasts irreversible txs against the DEPLOYED PaymentEscrow on Arc Testnet
// (chainId 5042002). It is OPERATOR-GATED exactly like Phase 1's ArcScan verify
// (contracts/DEPLOY.md): the autonomous Task-1 suite (echo-money-path.test.ts) proves
// the `debit <= cap` LOGIC against a mocked chain; THIS script proves the GENUINE
// on-chain `Debited` event. It is NOT a phase blocker and is never run in CI.
//
// Why the LIVE RPC (not a fork): RESEARCH Pitfall 4 / A5 - Arc USDC is also the native
// gas token and its transfer path hits a blocklist PRECOMPILE that a local forge/anvil
// fork does not implement, so a forked state-changing settle reverts where the live
// send succeeds. Phase 1 hit the same wall and drove the money path with live `cast
// send`. The state-changing debit here MUST run against the live Arc RPC.
//
// Run (operator, post-merge):
//   1. Fund the buyer + relayer EOAs with native USDC at https://faucet.circle.com.
//   2. Set TEST_BUYER_PRIVATE_KEY + RELAYER_SIGNER_KEYS in .env.local (gitignored).
//   3. node packages/x402-arc/examples/echo/live-money-path.ts
//   4. Confirm the printed ArcScan tx shows a Debited event with debit <= cap and the
//      70/30 creator/treasury split.
//
// SECURITY: keys are read ONLY from .env.local and are NEVER logged. The relayer key
// is the escrow admin (on testnet the deployer EOA 0xDa8c5726..., collapsed roles).
import { config as loadEnv } from "dotenv";
import { serve } from "@hono/node-server";
import {
  decodeEventLog,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  createArcPublicClient,
  createArcWalletClient,
  escrowAbi,
  erc20Abi,
  USDC,
  PAYMENT_ESCROW,
} from "@utter/chain";
import {
  signDebitAuthorization,
  encodePayment,
  computeValidBefore,
  type Pricing,
  type PaymentPayload,
  type FetchLike,
} from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryStores } from "@utter/facilitator/stores/memory";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import { createRelayerPool } from "@utter/facilitator/relayer";
import { createEchoServer } from "./server";

loadEnv({ path: ".env.local" });

// The demo resource + pricing for the live run. resourceId is a deterministic
// bytes32 derived from a label (any registered resource id works for a live run).
const RESOURCE_ID: Hex = keccak256(toHex("utter:echo:live-money-path"));
const MAX_TIMEOUT_SECONDS = Number(process.env.RESOURCE_TIMEOUT_SECONDS ?? "30");
const SETTLE_BUFFER_SECONDS = Number(process.env.SETTLE_BUFFER_SECONDS ?? "90");
const PORT = Number(process.env.PORT ?? "8799");
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: Number(process.env.MAX_RESPONSE_BYTES ?? "1048576"),
};

/** Read a required env var or exit with an operator-friendly message (never logs the value). */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `[live-money-path] missing ${name}. Fund the buyer + relayer at ` +
        `https://faucet.circle.com and set ${name} in .env.local (gitignored). ` +
        `See packages/x402-arc/examples/echo/README.md.`,
    );
    process.exit(1);
  }
  return value;
}

/** A 0x-prefixed bytes32 random nonce (the idemKey for this live call). */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

async function main(): Promise<void> {
  // (0) Keys from .env.local ONLY. The relayer pool is the escrow admin (testnet:
  // the deployer EOA, collapsed roles). Never logged.
  const buyerKey = requireEnv("TEST_BUYER_PRIVATE_KEY") as Hex;
  const relayerKeysRaw = requireEnv("RELAYER_SIGNER_KEYS");
  const relayerKeys = relayerKeysRaw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0) as Hex[];
  const rpcUrl = process.env.ARC_RPC_URL;

  const publicClient = createArcPublicClient(rpcUrl) as PublicClient;
  const buyerAccount = privateKeyToAccount(buyerKey);
  const buyer: Address = buyerAccount.address;
  const buyerWallet = createArcWalletClient(buyerAccount, rpcUrl);

  // Sanity: confirm we are on Arc Testnet before spending anything.
  const chainId = await publicClient.getChainId();
  if (chainId !== arcTestnet.id) {
    console.error(`[live-money-path] wrong chain ${chainId}, expected ${arcTestnet.id} (Arc Testnet)`);
    process.exit(1);
  }
  console.log(`[live-money-path] buyer ${buyer} on Arc Testnet (chainId ${chainId})`);

  // Read USDC decimals at runtime (never hardcode) only to format human amounts.
  const decimals = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;

  // The signed cap for this call (base units). 0.01 USDC = 10_000 base units at 6dp;
  // derived from decimals at runtime so no decimals literal drives the amount.
  const cap = 10n ** BigInt(decimals) / 100n; // 0.01 USDC

  // (1) ENSURE the buyer's escrow balance >= cap. deposit() pulls USDC from the buyer
  // into PaymentEscrow; the gate's /verify checks balanceOf(buyer) >= cap on-chain.
  const escrowBalance = (await publicClient.readContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  if (escrowBalance < cap) {
    const need = cap - escrowBalance;
    console.log(`[live-money-path] depositing ${need} base units into PaymentEscrow...`);
    const depositTx = await buyerWallet.writeContract({
      address: PAYMENT_ESCROW,
      abi: escrowAbi,
      functionName: "deposit",
      args: [need],
      account: buyerAccount,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`[live-money-path] deposit confirmed: ${arcTestnet.blockExplorers?.default.url}/tx/${depositTx}`);
  } else {
    console.log(`[live-money-path] buyer escrow balance ${escrowBalance} >= cap ${cap} (no deposit needed)`);
  }

  // (2) Start the echo server pointed at an IN-PROCESS facilitator whose relayer pool
  // signs against the LIVE Arc RPC (the escrow admin). The /settle debit therefore
  // broadcasts a real tx to the deployed PaymentEscrow (Pitfall 4: live RPC, not a fork).
  const stores = createInMemoryStores();
  const relayerPool = createRelayerPool(relayerKeys, rpcUrl, { publicClient });
  const facilitator = createApp({
    store: stores.payments,
    resultStore: stores.results,
    relayerPool,
    publicClient,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_ESCROW, // exact path unused here (escrow scheme only)
    usdcAddress: USDC,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
  });
  const facilitatorServer = serve({ fetch: facilitator.fetch, port: PORT });
  const facilitatorUrl = `http://127.0.0.1:${PORT}`;

  // Route the gate's facilitator calls through the in-process app (same process, but
  // every /settle still broadcasts a LIVE on-chain debit via the relayer pool).
  const fetcher: FetchLike = async (input, init) =>
    facilitator.request(input, { method: init?.method, headers: init?.headers, body: init?.body });

  const echo = createEchoServer({
    facilitatorUrl,
    resourceId: RESOURCE_ID,
    cap,
    pricing: PRICING,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    fetcher,
  });

  try {
    const text = "live";
    const reqInit = {
      method: "POST",
      headers: { "content-type": "application/json" } as Record<string, string>,
      body: JSON.stringify({ text }),
    };

    // (3) GET /echo with no X-PAYMENT -> expect 402 with the accepts quote.
    const unpaid = await echo.request("/echo", reqInit);
    if (unpaid.status !== 402) {
      throw new Error(`expected 402 on the unpaid call, got ${unpaid.status}`);
    }
    console.log("[live-money-path] unpaid call returned 402 (accepts advertised)");

    // (4) Sign a real DebitAuthorization under the LOCKED UtterEscrow/1 domain.
    const nonce = randomNonce();
    const validBefore = computeValidBefore(MAX_TIMEOUT_SECONDS, SETTLE_BUFFER_SECONDS);
    const signed = await signDebitAuthorization(buyerWallet, {
      buyer,
      resourceId: RESOURCE_ID,
      maxAmount: cap,
      nonce,
      validBefore,
    });
    const payload: PaymentPayload = {
      x402Version: 2,
      scheme: "utter-escrow",
      network: "eip155:5042002",
      authorization: {
        buyer,
        resourceId: RESOURCE_ID,
        maxAmount: cap.toString(),
        nonce,
        validBefore: validBefore.toString(),
      },
      signature: signed.signature,
    };
    const header = encodePayment(payload);

    // (5) Re-GET with X-PAYMENT -> expect 200 + the X-PAYMENT-RESPONSE receipt. This
    // path triggers the LIVE escrow debit (the only real money move) via /settle.
    const paid = await echo.request("/echo", {
      ...reqInit,
      headers: { ...reqInit.headers, "X-PAYMENT": header },
    });
    if (paid.status !== 200) {
      throw new Error(`expected 200 on the paid call, got ${paid.status}: ${await paid.text()}`);
    }
    const receiptHeader = paid.headers.get("X-PAYMENT-RESPONSE");
    if (!receiptHeader) throw new Error("missing X-PAYMENT-RESPONSE receipt header");
    const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as {
      tx: Hex;
      amount: string;
    };
    console.log(`[live-money-path] paid call 200; settle tx ${receipt.tx}`);
    console.log(`[live-money-path] ArcScan: ${arcTestnet.blockExplorers?.default.url}/tx/${receipt.tx}`);

    // (6) Read the on-chain Debited event for this tx and ASSERT debit <= cap + the
    // 70/30 creator/treasury split (the genuine on-chain proof).
    const txReceipt = await publicClient.getTransactionReceipt({ hash: receipt.tx });
    const debited = txReceipt.logs
      .filter((l) => l.address.toLowerCase() === PAYMENT_ESCROW.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: escrowAbi, data: l.data, topics: l.topics }) as {
            eventName: string;
            args: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      })
      .find((d) => d?.eventName === "Debited");
    if (!debited) throw new Error("no Debited event found in the settle tx");

    const amount = debited.args.amount as bigint;
    const toCreator = debited.args.toCreator as bigint;
    const toTreasury = debited.args.toTreasury as bigint;
    if (amount > cap) throw new Error(`debit ${amount} exceeds cap ${cap}`);
    if (toCreator + toTreasury !== amount) {
      throw new Error(`split ${toCreator}+${toTreasury} != amount ${amount}`);
    }
    // 70/30 split (floored): treasury gets floor(amount * 3000 / 10000).
    const expectedTreasury = (amount * 3000n) / 10000n;
    if (toTreasury !== expectedTreasury) {
      throw new Error(`treasury cut ${toTreasury} != expected 30% ${expectedTreasury}`);
    }

    console.log(
      `[live-money-path] OK: debit ${amount} <= cap ${cap}; ` +
        `creator ${toCreator} (70%) / treasury ${toTreasury} (30%) split verified on-chain.`,
    );
  } finally {
    facilitatorServer.close();
  }
}

main().catch((err) => {
  console.error("[live-money-path] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
