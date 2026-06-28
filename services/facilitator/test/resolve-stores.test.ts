// resolve-stores suite (P0-5 / P1-4): the production durability fail-closed checks in
// server.ts (mirrors the resolveAuthConfig FACILITATOR_AUTH_SECRET fail-fast).
//
//   resolveFacilitatorStores (P0-5):
//     both DATABASE_URL + REDIS_URL set            -> pg+redis adapter (PgRedis* instances)
//     production + EITHER URL missing              -> THROWS, naming the missing var (never its value)
//     dev/test  + neither URL set                  -> in-memory default (unchanged dev default)
//
//   the spend-cap guard via buildDepsFromEnv (P1-4):
//     production + cap ARMED + only in-memory store -> THROWS (free-compute reset vector)
//     dev/test  + cap ARMED                         -> in-memory spendCapStore wired (no throw)
//     production + cap NOT armed                    -> no spend-cap throw
//
// Fully offline: no real pg/redis query is ever issued. The pg+redis case asserts only
// by CLASS (instanceof PgRedis*) and disconnects/ends every client it constructs in a
// finally so the vitest worker does not hang on an open handle. Each test saves/restores
// the touched process.env keys (mirrors resource-auth-config.test.ts) so cases never
// leak NODE_ENV / URLs / cap into siblings.
import { describe, it, expect, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { resolveFacilitatorStores, buildDepsFromEnv } from "../src/server";
import { createInMemoryStores } from "../src/stores/memory";
import { PgRedisPaymentStore, PgRedisResultStore } from "../src/stores/pgRedis";

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "RELAYER_SIGNER_KEYS",
  "SPEND_CAP_PER_PAYER_24H_BASE_UNITS",
  "SPEND_CAP_PER_PAYER_DAY",
  "FACILITATOR_AUTH_SECRET",
] as const;

// A >=32-char secret so a production buildDepsFromEnv reaches the spend-cap path
// instead of fail-fasting earlier on resolveAuthConfig (an unrelated prod gate).
const VALID_AUTH_SECRET = "facilitator-auth-secret-at-least-32-chars-long";

// A non-routable test URL: ioredis is told never to retry, and the client is
// disconnected synchronously in the finally, so no real connection completes.
const FAKE_PG = "postgresql://u:p@127.0.0.1:1/db";
const FAKE_REDIS = "redis://127.0.0.1:1";
const PER_PAYER_DAY_CAP = "1000000"; // 1 USDC at 6dp (a base-unit integer string)

describe("resolveFacilitatorStores + spend-cap guard (production durability fail-closed)", () => {
  const saved: Record<string, string | undefined> = {};

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
    for (const key of ENV_KEYS) {
      if (!(key in saved)) saved[key] = process.env[key];
    }
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (key in saved) {
        const v = saved[key];
        if (v === undefined) delete process.env[key];
        else process.env[key] = v;
        delete saved[key];
      }
    }
  });

  // --- (a) resolveFacilitatorStores -------------------------------------------------

  it("both DATABASE_URL + REDIS_URL set -> pg+redis adapter (asserted by class, no real query)", async () => {
    setEnv({ NODE_ENV: "production", DATABASE_URL: FAKE_PG, REDIS_URL: FAKE_REDIS });
    const stores = resolveFacilitatorStores();
    try {
      // Assert by class/marker only - we NEVER issue a query against these clients.
      expect(stores.payments).toBeInstanceOf(PgRedisPaymentStore);
      expect(stores.results).toBeInstanceOf(PgRedisResultStore);
    } finally {
      // Disconnect/end every client constructed inside the adapter so the vitest
      // worker has no open handle. The pg Pool / ioredis client live on private fields.
      const payments = stores.payments as unknown as {
        pg?: { end?: () => Promise<unknown> };
        redis?: { disconnect?: () => void };
      };
      const results = stores.results as unknown as { pg?: { end?: () => Promise<unknown> } };
      payments.redis?.disconnect?.();
      await payments.pg?.end?.().catch(() => {});
      await results.pg?.end?.().catch(() => {});
    }
  });

  it("production + DATABASE_URL missing -> THROWS naming DATABASE_URL (never its value)", () => {
    setEnv({ NODE_ENV: "production", DATABASE_URL: undefined, REDIS_URL: FAKE_REDIS });
    expect(() => resolveFacilitatorStores()).toThrow(/DATABASE_URL/);
  });

  it("production + REDIS_URL missing -> THROWS naming REDIS_URL (never its value)", () => {
    setEnv({ NODE_ENV: "production", DATABASE_URL: FAKE_PG, REDIS_URL: undefined });
    expect(() => resolveFacilitatorStores()).toThrow(/REDIS_URL/);
  });

  it("production + blank URL is treated as missing -> THROWS", () => {
    setEnv({ NODE_ENV: "production", DATABASE_URL: "   ", REDIS_URL: "   " });
    expect(() => resolveFacilitatorStores()).toThrow();
  });

  it("never echoes the URL VALUES in the thrown error message", () => {
    const secretPg = "postgresql://leak-this-pg-value@host/db";
    setEnv({ NODE_ENV: "production", DATABASE_URL: secretPg, REDIS_URL: undefined });
    try {
      resolveFacilitatorStores();
      throw new Error("expected resolveFacilitatorStores to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // It is allowed to name REDIS_URL (the missing var) but never any URL value.
      expect(msg).not.toContain("leak-this-pg-value");
      expect(msg).not.toContain(secretPg);
    }
  });

  it("dev (NODE_ENV unset) + neither URL set -> in-memory default (unchanged dev behavior)", () => {
    setEnv({ NODE_ENV: undefined, DATABASE_URL: undefined, REDIS_URL: undefined });
    const stores = resolveFacilitatorStores();
    const reference = createInMemoryStores();
    expect(stores.payments).toBeInstanceOf(
      reference.payments.constructor as new (...args: never[]) => unknown,
    );
    expect(stores.results).toBeInstanceOf(
      reference.results.constructor as new (...args: never[]) => unknown,
    );
  });

  it("test + only one URL set -> in-memory default (incomplete config is dev-safe)", () => {
    setEnv({ NODE_ENV: "test", DATABASE_URL: FAKE_PG, REDIS_URL: undefined });
    const stores = resolveFacilitatorStores();
    expect(stores.payments).not.toBeInstanceOf(PgRedisPaymentStore);
  });

  // --- (b) the spend-cap guard via buildDepsFromEnv ---------------------------------
  //
  // RELAYER_SIGNER_KEYS is set first so buildDepsFromEnv reaches store/spend-cap
  // resolution (it fail-fasts on missing relayer keys before anything else). Both
  // DATABASE_URL + REDIS_URL are set so the store-resolution branch passes and ONLY the
  // spend-cap branch is under test. Any pg/redis client buildDepsFromEnv constructs is
  // disconnected/ended in the finally so no handle is left open.

  // Disconnect/end any pg/redis client a built deps object carries, so the worker has
  // no open handle. A no-op for in-memory deps. Returns the deps for assertions.
  async function buildAndCleanup(): Promise<ReturnType<typeof buildDepsFromEnv>> {
    const deps = buildDepsFromEnv();
    const store = deps.store as unknown as {
      pg?: { end?: () => Promise<unknown> };
      redis?: { disconnect?: () => void };
    };
    const resultStore = deps.resultStore as unknown as { pg?: { end?: () => Promise<unknown> } };
    store?.redis?.disconnect?.();
    await store?.pg?.end?.().catch(() => {});
    await resultStore?.pg?.end?.().catch(() => {});
    return deps;
  }

  it("production + spend cap ARMED -> buildDepsFromEnv THROWS the spend-cap message", () => {
    setEnv({
      NODE_ENV: "production",
      RELAYER_SIGNER_KEYS: generatePrivateKey(),
      DATABASE_URL: FAKE_PG,
      REDIS_URL: FAKE_REDIS,
      FACILITATOR_AUTH_SECRET: VALID_AUTH_SECRET,
      SPEND_CAP_PER_PAYER_24H_BASE_UNITS: PER_PAYER_DAY_CAP,
    });
    // The store branch passes (both URLs set); the throw is the spend-cap guard.
    expect(() => buildDepsFromEnv()).toThrow(/SPEND_CAP_PER_PAYER_24H_BASE_UNITS/);
  });

  it("dev + spend cap ARMED -> in-memory spendCapStore wired (no throw)", async () => {
    setEnv({
      NODE_ENV: "development",
      RELAYER_SIGNER_KEYS: generatePrivateKey(),
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
      SPEND_CAP_PER_PAYER_24H_BASE_UNITS: PER_PAYER_DAY_CAP,
    });
    // No pg/redis client constructed here (dev + no URLs -> in-memory stores).
    const deps = buildDepsFromEnv();
    expect(deps.spendCapStore).toBeDefined();
    expect(deps.perPayerDayCap).toBe(BigInt(PER_PAYER_DAY_CAP));
  });

  it("production + spend cap NOT armed -> no spend-cap throw (durable stores still required)", async () => {
    setEnv({
      NODE_ENV: "production",
      RELAYER_SIGNER_KEYS: generatePrivateKey(),
      DATABASE_URL: FAKE_PG,
      REDIS_URL: FAKE_REDIS,
      FACILITATOR_AUTH_SECRET: VALID_AUTH_SECRET,
      SPEND_CAP_PER_PAYER_24H_BASE_UNITS: undefined,
      SPEND_CAP_PER_PAYER_DAY: undefined,
    });
    // buildDepsFromEnv must NOT throw (the store branch passes with both URLs set, and
    // the unarmed spend-cap path leaves the store unset). Build once, clean up its
    // pg/redis clients, then assert the spend-cap store stayed unset.
    const deps = await buildAndCleanup();
    expect(deps.spendCapStore).toBeUndefined();
  });
});
