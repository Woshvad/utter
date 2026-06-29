#!/usr/bin/env node
// bin/mcp.ts - the stdio entrypoint for the Utter buyer MCP server (BUY-02 / BUY-03).
// GREENFIELD (first bin in repo).
//
// Two modes, selected by BUYER_SDK_TRANSPORT:
//   * DEFAULT (unset or != "live") -> DEMO mode: a self-contained in-process wiring
//     (createDemoWiring) - an EPHEMERAL throwaway wallet, the fixture transport (mock
//     chain + a debit-counting relayer), and a built-in echo card. An agent (Claude
//     Desktop / Cursor) connects over stdio and runs the REAL discover -> reserve ->
//     handler -> settle pay loop (exactly-once, debit <= cap) entirely in-process: NO
//     on-chain money, NO real network, NO deployed resource. The demo NEVER reads
//     BUYER_PRIVATE_KEY.
//   * "live" -> the operator-gated LIVE path: read the buyer key ONCE from env into the
//     wallet (held in the client closure, NEVER logged), selectBuyerTransport(env) ->
//     createLiveTransport, which throws RequiresLiveBuyerError (a real funded key + a
//     deployed resource over HTTPS are provisioned separately). Fail-loud, unchanged - the
//     autonomous build NEVER fakes a live run.
//
// ZERO stdout writes (Pitfall 1 / T-07-STDOUT): stdout carries the JSON-RPC frames. ALL
// diagnostics go to stderr (console.error) only. The buyer key NEVER appears in a log
// line (T-07-KEYLEAK): the live path reads process.env.BUYER_PRIVATE_KEY into the account
// and never echoes it; the demo path generates an ephemeral key and never logs it either.
import { config as loadDotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "@utter/chain";

import { selectBuyerTransport } from "../transport.js";
import { createBuyerClient } from "../client.js";
import { createDemoWiring } from "../demo.js";
import { createMcpServerAsync } from "../mcp/server.js";
import { createBudgetGuard, readBudgetCapsFromEnv } from "../mcp/budget.js";
import type { CardListSource } from "../mcp/tools.js";
import { createLiveCardSource } from "../mcp/live-discovery.js";

/**
 * Build the buyer wallet from the .env.local key. The key is read ONCE here and held in
 * the wallet (then the client closure); it is NEVER logged or returned. Throws (to stderr,
 * never stdout) when absent on the live path.
 */
function buyerWalletFromEnv(env: NodeJS.ProcessEnv) {
  const raw = env.BUYER_PRIVATE_KEY;
  if (!raw || raw.trim() === "") {
    // No key: the fixture path supplies its own wallet via the harness; the live path
    // fail-louds in selectBuyerTransport before this is needed.
    return null;
  }
  const account = privateKeyToAccount(raw.trim() as Hex);
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
  });
}

/**
 * The live discovery source reads the deployed marketplace index. It is operator-gated:
 * the operator must set MARKETPLACE_INDEX_URL in .env.local (we fail loud when absent).
 * Once set, it delegates to createLiveCardSource, which reads the PUBLIC marketplace
 * GET /resources (global fetch) and projects each row to a DiscoveredCard using the TRUSTED
 * @utter/chain constants for escrow/asset and the resourceId for payTo. The live PATH is
 * still gated upstream by selectBuyerTransport (RequiresLiveBuyerError); this only makes the
 * discovery READ real. Diagnostics on stderr only - never stdout.
 */
function liveCardSource(env: NodeJS.ProcessEnv): CardListSource {
  const url = env.MARKETPLACE_INDEX_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "utter-buyer-mcp: live discovery requires MARKETPLACE_INDEX_URL in .env.local " +
        "(operator-gated; the live BUY-03 demo is provisioned separately).",
    );
  }
  return createLiveCardSource({ marketplaceIndexUrl: url.trim() });
}

/**
 * Boot the DEMO server (the default mode): a self-contained in-process wiring with an
 * EPHEMERAL throwaway wallet, the fixture transport (mock chain + a debit-counting
 * relayer), and a built-in echo card. NO real money/network/resource, and the demo NEVER
 * reads BUYER_PRIVATE_KEY. The endpoint tool runs the real pay loop in-process against the
 * mock chain. Returns the created server (the caller connects it to stdio).
 */
async function buildDemoServer(env: NodeJS.ProcessEnv) {
  const demo = createDemoWiring();

  // CR-01: the buyer-configured per-call ceiling in WHOLE USDC tokens, read from
  // .env.local (never from a card). Honored in demo mode too so a demo run can exercise
  // the ceiling clamp. Empty/blank = no buyer ceiling (the card cap is the only bound).
  const rawMaxCap = env.BUYER_MAX_CAP_TOKENS;
  const maxCapTokens =
    rawMaxCap && rawMaxCap.trim() !== "" ? BigInt(rawMaxCap.trim()) : undefined;

  const client = createBuyerClient({
    transport: demo.transport,
    buyerWallet: demo.buyerWallet,
    cardSource: demo.clientCardSource,
    env,
    maxCapTokens,
  });
  const budget = createBudgetGuard(readBudgetCapsFromEnv(env));

  return createMcpServerAsync({ client, cardSource: demo.cardSource, budget });
}

/**
 * Boot the LIVE server (operator-gated, fail-loud): read the buyer key ONCE into the
 * wallet, select the live transport (which throws RequiresLiveBuyerError until a funded
 * key + deployed resource are provisioned), and wire the live marketplace discovery
 * (also operator-gated). The autonomous build NEVER reaches a real run here.
 */
async function buildLiveServer(env: NodeJS.ProcessEnv) {
  // selectBuyerTransport with BUYER_SDK_TRANSPORT=live -> createLiveTransport ->
  // RequiresLiveBuyerError. The live path needs the funded buyer wallet + a deployed
  // resource over HTTPS - none in the autonomous build, so it fail-louds here.
  const wallet = buyerWalletFromEnv(env);
  const transport = selectBuyerTransport(env);

  if (!wallet) {
    throw new Error(
      "utter-buyer-mcp: no BUYER_PRIVATE_KEY in .env.local. Set the buyer key (and " +
        "BUYER_SDK_TRANSPORT=live + a deployed resource) to run the operator-gated live " +
        "server. Unset BUYER_SDK_TRANSPORT to run the in-process DEMO server instead.",
    );
  }

  // CR-01: the buyer-configured per-call ceiling in WHOLE USDC tokens, read from
  // .env.local (never from a card). It caps what the client will EVER sign regardless of a
  // poisoned card's advertised pricing.max. Empty/blank = no buyer ceiling (the card cap is
  // the only bound). The bin reads it once into the client config; it is non-secret.
  const rawMaxCap = env.BUYER_MAX_CAP_TOKENS;
  const maxCapTokens =
    rawMaxCap && rawMaxCap.trim() !== "" ? BigInt(rawMaxCap.trim()) : undefined;

  const client = createBuyerClient({ transport, buyerWallet: wallet, env, maxCapTokens });
  const budget = createBudgetGuard(readBudgetCapsFromEnv(env));

  return createMcpServerAsync({ client, cardSource: liveCardSource(env), budget });
}

/** The bin main. Diagnostics to STDERR only; the buyer key is never logged. */
async function main(): Promise<void> {
  // Load .env.local (the secret-bearing file; .env.example holds only placeholders).
  // `quiet: true` is LOAD-BEARING here (Pitfall 1 / T-07-STDOUT): dotenv v17 prints an
  // "injected env" banner to STDOUT by default, which would corrupt the JSON-RPC frame
  // channel the moment this bin connects over stdio. (The other dotenv load that fires for
  // this bin - @utter/deployer's top-level live-deploy load, reached transitively via
  // @utter/ai-runtime - is likewise silenced at its source.)
  loadDotenv({ path: ".env.local", quiet: true });
  const env = process.env;

  // DEFAULT = DEMO mode (in-process, no real money). Only BUYER_SDK_TRANSPORT=live opts
  // into the operator-gated live path (fail-loud). This mirrors selectBuyerTransport's
  // own discriminator so the bin and the transport seam agree.
  const live = env.BUYER_SDK_TRANSPORT === "live";
  const created = live ? await buildLiveServer(env) : await buildDemoServer(env);

  // Connect over stdio. From here, stdout is owned by the JSON-RPC framing - we write
  // NOTHING to it. Startup diagnostics go to stderr.
  await created.connect(new StdioServerTransport());
  if (live) {
    console.error("utter-buyer-mcp: LIVE mode connected over stdio (diagnostics on stderr).");
  } else {
    console.error(
      "utter-buyer-mcp: DEMO mode (in-process, no real money) connected over stdio.",
    );
  }
}

main().catch((err: unknown) => {
  // STDERR only - never stdout (Pitfall 1). Never echo the buyer key.
  console.error("utter-buyer-mcp: fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
