#!/usr/bin/env node
// bin/pay.ts - the operator CLI that funds the test-buyer escrow once and fires N real paid
// calls to a DEPLOYED Utter resource. This is the demo "an agent pays per call" driver and
// the pre-record live smoke test.
//
// It is a PLAIN CLI (not the MCP stdio server), so stdout carries human progress, not
// JSON-RPC frames: console.log is fine here. The buyer key is read ONCE from the environment
// into the wallet and is NEVER logged (T-07-KEYLEAK); no diagnostic echoes it.
//
// USAGE (run on the host, from the repo root or the package dir):
//   pnpm --filter @utter/buyer-sdk pay -- --url <resourceBaseUrl> [--calls N] [--apply]
//
//   --url <url>          the resource base URL (or its full agent-card URL). Required.
//   --calls <N>          how many real paid calls to fire (default 1). The one-time deposit
//                        is sized to cap * N so a fresh buyer can pay every call.
//   --resource-id <0x..> optional bytes32 to BIND the card payTo against (H4). Omitted ->
//                        the card is trusted by its URL and its payTo is used as discovered.
//   --body '<json>'      optional request body POSTed to the handler (default: a benign echo).
//   --apply              actually deposit + pay. WITHOUT it this is a DRY-RUN: it reads the
//                        card + the buyer escrow balance and prints the sizing plan, making
//                        ZERO chain writes and ZERO paid calls.
//
// ENV (.env.local at the repo root):
//   TEST_BUYER_PRIVATE_KEY  the funded buyer EOA key (required). Read once; never logged.
//   ARC_RPC_URL             optional Arc RPC override (falls back to the chain default).
//
// Example (fire 10 real paid calls to the utc-time endpoint):
//   pnpm --filter @utter/buyer-sdk pay -- \
//     --url https://return-the-current-utc-time-as-json.resources.utter.technology \
//     --calls 10 --apply
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import type { Hex, PublicClient } from "viem";
import { createArcPublicClient, createArcWalletClientFromKey } from "@utter/chain";

import { parseDemoPayArgs, runDemoPay } from "../demo-pay.js";

/**
 * Load .env.local. Secrets live in the REPO-ROOT .env.local (the deployer convention), so we
 * load that explicitly (computed from this file's location) and also the cwd .env.local when
 * run from a package dir. dotenv never overrides an already-set process.env value, so an
 * operator who exported the key wins, and `quiet: true` suppresses the v17 stdout banner.
 */
function loadEnv(): void {
  // packages/buyer-sdk/src/bin/pay.ts -> up four segments to the repo root.
  const rootEnv = fileURLToPath(new URL("../../../../.env.local", import.meta.url));
  loadDotenv({ path: rootEnv, quiet: true });
  loadDotenv({ path: ".env.local", quiet: true });
}

async function main(): Promise<void> {
  loadEnv();
  const env = process.env;
  const args = parseDemoPayArgs(process.argv.slice(2));

  // The buyer key is required for BOTH modes: a dry-run reads the real buyer's escrow balance
  // (to show whether a deposit is even needed), and apply signs the deposit + pays. Read it
  // ONCE into the wallet; it is never logged and never leaves this scope.
  const key = env.TEST_BUYER_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      "set TEST_BUYER_PRIVATE_KEY (the funded buyer EOA) in the repo-root .env.local. It is " +
        "read once into the wallet and never logged.",
    );
  }
  const rpc = env.ARC_RPC_URL;
  const publicClient = createArcPublicClient(rpc) as PublicClient;
  const walletClient = createArcWalletClientFromKey(key as Hex, rpc);

  const result = await runDemoPay({
    cardUrl: args.cardUrl,
    calls: args.calls,
    apply: args.apply,
    resourceId: args.resourceId,
    requestBody: args.requestBody,
    env,
    publicClient,
    walletClient,
  });

  // Exit non-zero when an APPLY run did not pay every call, so a host/CI invocation detects a
  // broken money path. A dry-run always exits 0 (it asserts nothing on-chain).
  if (result.applied && result.paidCount < result.calls) {
    console.error(
      `demo-pay: only ${result.paidCount}/${result.calls} calls paid (expected all). ` +
        `See the per-call statuses above.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  // Never echo the buyer key. Diagnostics only.
  console.error("demo-pay: fatal:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
