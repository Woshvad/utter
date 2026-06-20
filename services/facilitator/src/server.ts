// The facilitator server bootstrap (PAY-09, PAY-10). Loads `.env.local`, builds the
// relayer pool + public client + stores, and serves the Hono app via
// @hono/node-server. Fail-fast with an operator-friendly message when a required
// env var is missing (mirrors packages/chain/test/chain.test.ts beforeAll).
//
// SECURITY: RELAYER_SIGNER_KEYS is read from `.env.local` (gitignored) and passed
// straight into the relayer pool. It is NEVER logged, never echoed, never persisted.
// Only the key COUNT is ever surfaced (so an operator can confirm the pool size
// without leaking material).
//
// Store selection: when DATABASE_URL + REDIS_URL are set the real Postgres+Redis
// adapter is used; otherwise the in-memory default (the test/dev fallback). The
// route logic is identical against either adapter (the shared store contract).
import { config as loadEnv } from "dotenv";
import { serve } from "@hono/node-server";
import { type Hex, type PublicClient } from "viem";
import { createArcPublicClient, PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC } from "@utter/chain";
import { createApp, type AppDeps } from "./app";
import { createRelayerPool } from "./relayer";
import { createInMemoryBuyerLock } from "./verify";
import { createInMemoryStores, type FacilitatorStores } from "./stores/memory";
import { createPgRedisStores } from "./stores/pgRedis";

loadEnv({ path: ".env.local" });

/** Parse a comma/whitespace-separated RELAYER_SIGNER_KEYS env value into 0x keys. */
function parseRelayerKeys(raw: string | undefined): Hex[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0) as Hex[];
}

/** Build the route deps from the environment (fail-fast on missing required env). */
export function buildDepsFromEnv(): AppDeps {
  const relayerKeys = parseRelayerKeys(process.env.RELAYER_SIGNER_KEYS);
  if (relayerKeys.length === 0) {
    // Operator-friendly fail-fast (mirror chain.test.ts beforeAll) - the facilitator
    // cannot settle without at least one relayer key. NEVER print the value itself.
    throw new Error(
      "set RELAYER_SIGNER_KEYS in .env.local (one or more 0x relayer private keys, comma-separated)",
    );
  }

  const rpcUrl = process.env.ARC_RPC_URL; // optional - falls back to the chain default
  const settleBufferSeconds = Number(process.env.SETTLE_BUFFER_SECONDS ?? "90");
  const resultTtlSeconds = Number(process.env.RESULT_TTL_SECONDS ?? String(24 * 60 * 60));
  const maxTimeoutSeconds = Number(process.env.RESOURCE_TIMEOUT_SECONDS ?? "30");

  const publicClient = createArcPublicClient(rpcUrl) as PublicClient;
  const relayerPool = createRelayerPool(relayerKeys, rpcUrl, { publicClient });

  // Store selection: real pg+redis when both URLs are set, else the in-memory default.
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const stores: FacilitatorStores =
    databaseUrl && redisUrl
      ? createPgRedisStores({ databaseUrl, redisUrl })
      : createInMemoryStores();

  return {
    store: stores.payments,
    resultStore: stores.results,
    relayerPool,
    publicClient,
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds,
    settleBufferSeconds,
    resultTtlSeconds,
  };
}

/** Start the facilitator HTTP server on the given port (default 8787). */
export function start(port = Number(process.env.PORT ?? "8787")): void {
  const deps = buildDepsFromEnv();
  const app = createApp(deps);
  // Log only the relayer pool SIZE and port - never a key.
  console.log(
    `facilitator listening on :${port} (relayer pool size ${deps.relayerPool.signers.length})`,
  );
  serve({ fetch: app.fetch, port });
}

// Boot when run directly (node src/server.ts), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
