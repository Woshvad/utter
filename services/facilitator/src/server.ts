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
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { type Hex, type PublicClient } from "viem";
import { createArcPublicClient, PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC } from "@utter/chain";
import { InMemorySpendCapStore, type SpendCapStore } from "@utter/data-proxy";
import { InMemoryRevenueLedger } from "@utter/x402-arc";
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

/** The minimum byte length we require of a real FACILITATOR_AUTH_SECRET in production. */
const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Resolve the per-resource caller-auth config from the environment (C1).
 *
 * FACILITATOR_AUTH_SECRET lives in .env.local only; it is never hardcoded, never
 * logged. Fail-closed in production (mirrors the RELAYER_SIGNER_KEYS fail-fast and
 * the studio SESSION_SECRET fix): when NODE_ENV is "production" the secret MUST be
 * set, non-blank after trim, AND at least 32 chars, else we THROW at boot - an
 * open money/control plane in production is the C1 vulnerability. In dev/test an
 * unset secret leaves auth UNENFORCED (the in-process money path passes through),
 * so the autonomous suite runs without provisioning a secret.
 */
export function resolveAuthConfig(): { authSecret?: string; authEnforced: boolean } {
  const fromEnv = process.env.FACILITATOR_AUTH_SECRET;
  const trimmed = (fromEnv ?? "").trim();

  if (process.env.NODE_ENV === "production") {
    if (trimmed.length < MIN_AUTH_SECRET_LENGTH) {
      // Fail loud. Do not echo the (missing/short) secret; just tell the operator.
      throw new Error(
        "FACILITATOR_AUTH_SECRET must be set to a non-empty value of at least " +
          `${MIN_AUTH_SECRET_LENGTH} characters in production. Set FACILITATOR_AUTH_SECRET ` +
          "in the deployment environment (.env.local / secrets manager); per-resource " +
          "caller auth is never disabled in production.",
      );
    }
    return { authSecret: fromEnv as string, authEnforced: true };
  }

  // Dev/test: an unset/blank secret leaves auth UNENFORCED (pass-through). When a
  // secret IS provided locally, enforce it so the enforced path can be exercised.
  if (trimmed.length === 0) return { authEnforced: false };
  return { authSecret: fromEnv as string, authEnforced: true };
}

/**
 * Resolve the facilitator stores from the environment (P0-5). Mirrors
 * resolveAuthConfig's fail-closed style.
 *
 * When BOTH DATABASE_URL and REDIS_URL are set (non-empty after trim) the real
 * Postgres+Redis adapter is used. In production an incomplete durable config
 * FAILS CLOSED at boot: the facilitator's reservations, the exactly-once result
 * cache, and the strike counter MUST be durable, since an in-memory store loses
 * live reservations + the exactly-once guard on restart. In dev/test (at least
 * one URL missing, NODE_ENV not "production") the in-memory default is used so the
 * autonomous suite needs no pg/redis. The thrown error is VALUE-FREE: it names
 * which var is missing but NEVER echoes DATABASE_URL / REDIS_URL.
 */
export function resolveFacilitatorStores(): FacilitatorStores {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const redisUrl = (process.env.REDIS_URL ?? "").trim();

  if (databaseUrl.length > 0 && redisUrl.length > 0) {
    return createPgRedisStores({ databaseUrl, redisUrl });
  }

  if (process.env.NODE_ENV === "production") {
    // Fail loud. Name the missing var(s); never echo the values.
    const missing: string[] = [];
    if (databaseUrl.length === 0) missing.push("DATABASE_URL");
    if (redisUrl.length === 0) missing.push("REDIS_URL");
    throw new Error(
      `set ${missing.join(" and ")} in production: the facilitator's reservations, ` +
        "exactly-once result cache, and strike counter must be durable; an in-memory " +
        "store loses live reservations and the exactly-once guard on restart.",
    );
  }

  return createInMemoryStores();
}

/**
 * Resolve the per-payer spend-cap store from the environment (P1-4). Mirrors
 * resolveAuthConfig's fail-closed style.
 *
 * When the cap is ARMED (perPayerDayCap !== undefined) in production this FAILS
 * CLOSED: the in-memory store resets the rolling-24h window on restart, a
 * free-compute reset vector. In dev/test an armed cap uses the in-memory store
 * exactly as before. When the cap is NOT armed (the default) no store is built and
 * no error is thrown, so the unarmed path is unchanged. The thrown error is
 * VALUE-FREE. P1-4 FOLLOW-UP: a Redis-backed SpendCapStore adapter (the contract
 * already exists in @utter/data-proxy) will let the spend cap be armed in
 * production; until it lands, arming the cap in production fails closed here.
 */
export function resolveSpendCapStore(perPayerDayCap: bigint | undefined): SpendCapStore | undefined {
  if (perPayerDayCap === undefined) return undefined;

  if (process.env.NODE_ENV === "production") {
    // Fail loud. The message names no secret/value (the cap is the only input).
    throw new Error(
      "arming SPEND_CAP_PER_PAYER_24H_BASE_UNITS in production requires a durable " +
        "Redis-backed spend-cap store; the in-memory store resets the rolling-24h " +
        "window on restart, a free-compute reset vector. The Redis SpendCapStore adapter " +
        "is a tracked follow-up; do not arm the spend cap in production until it lands.",
    );
  }

  return new InMemorySpendCapStore();
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

  // Store selection (P0-5): real pg+redis when both URLs are set; fail-closed in
  // production when the durable config is incomplete; in-memory default in dev/test.
  const stores: FacilitatorStores = resolveFacilitatorStores();

  // CR-01: per-payer rolling-24h spend cap. EMPTY by default (no env -> no cap -> the
  // gate is NOT armed and /verify behaves exactly as before). Set the DOCUMENTED
  // SPEND_CAP_PER_PAYER_24H_BASE_UNITS (a USDC base-unit integer, the name in
  // .env.example) to arm the deny-by-default free-compute guard; SPEND_CAP_PER_PAYER_DAY
  // is kept as a back-compat fallback for older .env.local files.
  const perPayerDayCapRaw =
    process.env.SPEND_CAP_PER_PAYER_24H_BASE_UNITS ?? process.env.SPEND_CAP_PER_PAYER_DAY;
  const perPayerDayCap =
    perPayerDayCapRaw && perPayerDayCapRaw.trim().length > 0
      ? BigInt(perPayerDayCapRaw.trim())
      : undefined;
  // P1-4: the in-memory spend-cap store is fail-closed in production (an armed cap on
  // an ephemeral store is a free-compute reset vector). The Redis SpendCapStore adapter
  // is the remaining follow-up that will let the spend cap be armed in production.
  const spendCapStore: SpendCapStore | undefined = resolveSpendCapStore(perPayerDayCap);

  // CR-02: the min-economical batching threshold. EMPTY by default (no env -> no
  // batching -> /settle settles immediately as before). Set MIN_ECONOMICAL_AMOUNT (a
  // USDC base-unit integer) to route sub-threshold debits into a per-resource
  // BatchSettler. The per-resource BatchSettler registry needs a per-resource buyer
  // batch-authorization seam (the buildBatchPayment signer), which is operator-provided
  // alongside the relayer/live wiring; until that is injected the threshold alone is a
  // no-op (batchSettler stays undefined), so this never silently drops to immediate
  // settle for a deployment that intended batching.
  const minEconomicalRaw = process.env.MIN_ECONOMICAL_AMOUNT;
  const minEconomicalAmount =
    minEconomicalRaw && minEconomicalRaw.trim().length > 0
      ? BigInt(minEconomicalRaw.trim())
      : undefined;

  // C1: per-resource caller auth. Fail-closed in production; pass-through in
  // dev/test when unset (keeps the in-process money path + suite green).
  const { authSecret, authEnforced } = resolveAuthConfig();

  // Per-resource revenue ledger for the studio dashboard (STU-04). DELIBERATELY the
  // in-memory adapter: revenue aggregation is process-local for this increment, so it
  // resets on restart. P2 FOLLOW-UP: a durable pg/redis-backed RevenueLedger (surviving
  // restarts) is an explicit LATER increment, wired behind the same RevenueLedger
  // contract. It is display-only aggregation (not the money path), so it is left as-is
  // here and not gated by the production fail-closed checks above.
  const revenueLedger = new InMemoryRevenueLedger();

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
    spendCapStore,
    perPayerDayCap,
    minEconomicalAmount,
    revenueLedger,
    authSecret,
    authEnforced,
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
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
