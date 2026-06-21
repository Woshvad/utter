#!/usr/bin/env node
// bin/mcp.ts - the stdio entrypoint for the Utter buyer MCP server (BUY-02 / BUY-03).
// GREENFIELD (first bin in repo).
//
// Flow: load .env.local (dotenv) -> read the buyer key ONCE from env into the wallet
// (held in the client closure, NEVER logged) -> selectBuyerTransport(env) (fixture
// default; live throws RequiresLiveBuyerError, operator-gated) -> build the client +
// createMcpServerAsync -> connect StdioServerTransport.
//
// ZERO stdout writes (Pitfall 1 / T-07-STDOUT): stdout carries the JSON-RPC frames. ALL
// diagnostics go to stderr (console.error) only. The buyer key NEVER appears in a log
// line (T-07-KEYLEAK) - we read process.env.BUYER_PRIVATE_KEY into the account and never
// echo it.
//
// The LIVE BUY-03 demo (a real Claude/Cursor agent depositing + paying over HTTPS against
// a live deployed resource) is operator-gated and fail-loud: with BUYER_SDK_TRANSPORT=live
// and no funded key/host, selectBuyerTransport -> createLiveTransport throws
// RequiresLiveBuyerError. The autonomous build NEVER fakes a live run.
import { config as loadDotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "@utter/chain";

import { selectBuyerTransport } from "../transport.js";
import { createBuyerClient } from "../client.js";
import { createMcpServerAsync } from "../mcp/server.js";
import { createBudgetGuard, readBudgetCapsFromEnv } from "../mcp/budget.js";
import type { CardListSource, DiscoveredCard } from "../mcp/tools.js";

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
 * The live discovery source reads the deployed marketplace index. It is operator-gated
 * (no marketplace URL provisioned in the autonomous build) and fail-louds rather than
 * fabricate a card list.
 */
function liveCardSource(env: NodeJS.ProcessEnv): CardListSource {
  return async (): Promise<DiscoveredCard[]> => {
    const url = env.MARKETPLACE_INDEX_URL;
    if (!url || url.trim() === "") {
      throw new Error(
        "utter-buyer-mcp: live discovery requires MARKETPLACE_INDEX_URL in .env.local " +
          "(operator-gated; the live BUY-03 demo is provisioned separately).",
      );
    }
    // The live marketplace read is wired here when provisioned; until then, fail loud.
    throw new Error(
      "utter-buyer-mcp: the live marketplace discovery read is operator-gated and not " +
        "provisioned in this build (BUY-03 live demo is a Deferred Item).",
    );
  };
}

/** The bin main. Diagnostics to STDERR only; the buyer key is never logged. */
async function main(): Promise<void> {
  // Load .env.local (the secret-bearing file; .env.example holds only placeholders).
  loadDotenv({ path: ".env.local" });
  const env = process.env;

  // selectBuyerTransport: fixture default; BUYER_SDK_TRANSPORT=live throws
  // RequiresLiveBuyerError (operator-gated). The live path needs the funded buyer wallet
  // + a deployed resource over HTTPS - none in the autonomous build, so it fail-louds.
  const wallet = buyerWalletFromEnv(env);
  const transport = selectBuyerTransport(env);

  if (!wallet) {
    throw new Error(
      "utter-buyer-mcp: no BUYER_PRIVATE_KEY in .env.local. Set the buyer key (and " +
        "BUYER_SDK_TRANSPORT=live + a deployed resource) to run the operator-gated live " +
        "server. The autonomous suite drives the tool handlers in-process instead.",
    );
  }

  const client = createBuyerClient({ transport, buyerWallet: wallet, env });
  const budget = createBudgetGuard(readBudgetCapsFromEnv(env));

  const created = await createMcpServerAsync({
    client,
    cardSource: liveCardSource(env),
    budget,
  });

  // Connect over stdio. From here, stdout is owned by the JSON-RPC framing - we write
  // NOTHING to it. Startup diagnostics go to stderr.
  await created.connect(new StdioServerTransport());
  console.error("utter-buyer-mcp: connected over stdio (diagnostics on stderr).");
}

main().catch((err: unknown) => {
  // STDERR only - never stdout (Pitfall 1). Never echo the buyer key.
  console.error("utter-buyer-mcp: fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
