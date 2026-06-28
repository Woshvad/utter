// resolve-stores suite (P0-5 / P1-4): the production durability fail-closed checks in
// server.ts (mirrors the resolveAuthConfig FACILITATOR_AUTH_SECRET fail-fast).
//
//   resolveFacilitatorStores (P0-5):
//     both DATABASE_URL + REDIS_URL set            -> pg+redis adapter (PgRedis* instances)
//     production + EITHER URL missing              -> THROWS, naming the missing var (never its value)
//     dev/test  + neither URL set                  -> in-memory default (unchanged dev default)
//
//   the spend-cap guard via buildDepsFromEnv (P1-4, durable Redis adapter now landed):
//     production + cap ARMED + both URLs set  -> RedisSpendCapStore (durable, no throw)
//     armed + REDIS_URL set (dev)             -> RedisSpendCapStore
//     armed + dev + no REDIS_URL              -> in-memory spendCapStore (no throw)
//     armed + production + no REDIS_URL       -> THROWS (defensive direct-call branch)
//     production + cap NOT armed              -> no spend-cap throw / no store
//
// Fully offline: no real pg/redis query is ever issued. The pg+redis case asserts only
// by CLASS (instanceof PgRedis*) and disconnects/ends every client it constructs in a
// finally so the vitest worker does not hang on an open handle. Each test saves/restores
// the touched process.env keys (mirrors resource-auth-config.test.ts) so cases never
// leak NODE_ENV / URLs / cap into siblings.
import { describe, it, expect, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  resolveFacilitatorStores,
  buildDepsFromEnv,
  resolveSpendCapStore,
  resolvePayerScreen,
} from "../src/server";
import { InMemoryPayerScreen } from "../src/payer-screen";
import { createInMemoryStores } from "../src/stores/memory";
import { PgRedisPaymentStore, PgRedisResultStore } from "../src/stores/pgRedis";
import { RedisSpendCapStore } from "../src/stores/spend-cap-redis";
import { InMemorySpendCapStore } from "@utter/data-proxy";

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
  // AMENDMENT 2: also disconnect the RedisSpendCapStore's ioredis client (the prod +
  // armed case now builds one) so the worker does not hang on an open handle.
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
    await disconnectSpendCapStore(deps.spendCapStore);
    return deps;
  }

  // Quit the ioredis client a RedisSpendCapStore wraps (via its disconnect()), so a
  // test that builds one against a non-routable URL leaves no open handle. A no-op for
  // an in-memory or undefined spend-cap store.
  async function disconnectSpendCapStore(spendCapStore: unknown): Promise<void> {
    const s = spendCapStore as { disconnect?: () => Promise<void> } | undefined;
    await s?.disconnect?.().catch(() => {});
  }

  it("production + spend cap ARMED + both URLs -> buildDepsFromEnv SUCCEEDS with a RedisSpendCapStore (durable; AMENDMENT 1)", async () => {
    setEnv({
      NODE_ENV: "production",
      RELAYER_SIGNER_KEYS: generatePrivateKey(),
      DATABASE_URL: FAKE_PG,
      REDIS_URL: FAKE_REDIS,
      FACILITATOR_AUTH_SECRET: VALID_AUTH_SECRET,
      SPEND_CAP_PER_PAYER_24H_BASE_UNITS: PER_PAYER_DAY_CAP,
    });
    // The durable Redis adapter now exists, so arming the cap in production no longer
    // fails closed: it gets a RedisSpendCapStore (production already requires REDIS_URL
    // via resolveFacilitatorStores, so REDIS_URL is always present here). Build once,
    // clean up every pg/redis/ioredis client (incl. the spend-cap one), then assert.
    const deps = await buildAndCleanup();
    expect(deps.spendCapStore).toBeInstanceOf(RedisSpendCapStore);
    expect(deps.perPayerDayCap).toBe(BigInt(PER_PAYER_DAY_CAP));
  });

  it("resolveSpendCapStore(cap, production + no REDIS_URL) -> THROWS (defensive direct-call branch; AMENDMENT 1)", () => {
    // This branch is unreachable through buildDepsFromEnv (resolveFacilitatorStores
    // fails first without REDIS_URL in production) but is correct on a direct call.
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => resolveSpendCapStore(BigInt(PER_PAYER_DAY_CAP), env)).toThrow(/REDIS_URL/);
  });

  it("resolveSpendCapStore never echoes the REDIS_URL value in the thrown error", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    try {
      resolveSpendCapStore(BigInt(PER_PAYER_DAY_CAP), env);
      throw new Error("expected resolveSpendCapStore to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // It may name REDIS_URL (the missing var) but never a URL value.
      expect(msg).not.toContain(FAKE_REDIS);
    }
  });

  it("resolveSpendCapStore(cap, REDIS_URL set) -> a RedisSpendCapStore (dev; AMENDMENT 1)", async () => {
    const env = { NODE_ENV: "development", REDIS_URL: FAKE_REDIS } as NodeJS.ProcessEnv;
    const store = resolveSpendCapStore(BigInt(PER_PAYER_DAY_CAP), env);
    try {
      expect(store).toBeInstanceOf(RedisSpendCapStore);
    } finally {
      // Disconnect the ioredis client constructed against the non-routable URL.
      await (store as RedisSpendCapStore | undefined)?.disconnect?.().catch(() => {});
    }
  });

  it("resolveSpendCapStore(cap, dev + no REDIS_URL) -> an InMemorySpendCapStore", () => {
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    const store = resolveSpendCapStore(BigInt(PER_PAYER_DAY_CAP), env);
    expect(store).toBeInstanceOf(InMemorySpendCapStore);
  });

  it("resolveSpendCapStore(undefined) -> undefined (unarmed, unchanged)", () => {
    expect(resolveSpendCapStore(undefined)).toBeUndefined();
    expect(
      resolveSpendCapStore(undefined, { NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBeUndefined();
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
    expect(deps.spendCapStore).toBeInstanceOf(InMemorySpendCapStore);
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

// --- resolvePayerScreen (Compliance track) ------------------------------------------
//
//   SANCTIONS_DENYLIST set                         -> InMemoryPayerScreen denying those
//   production + SANCTIONS_REQUIRED=1 + no list     -> THROWS (value-free, fail-closed)
//   dev + no list                                  -> undefined (UNARMED, unchanged)
//
// resolvePayerScreen takes an env parameter, so each case passes an explicit env object
// and never mutates process.env (no save/restore machinery needed here).
describe("resolvePayerScreen (payer sanctions screen, prod-fail-closed)", () => {
  it("SANCTIONS_DENYLIST set -> an InMemoryPayerScreen denying those addresses", async () => {
    const denied = "0xAbCdEf0000000000000000000000000000000001";
    const allowed = "0x0000000000000000000000000000000000000002";
    const env = { SANCTIONS_DENYLIST: `${denied}, 0xDEAD000000000000000000000000000000000003` } as NodeJS.ProcessEnv;
    const screen = resolvePayerScreen(env);
    expect(screen).toBeInstanceOf(InMemoryPayerScreen);
    // Denies the listed address case-insensitively; allows a non-listed one.
    expect(await screen!.isAllowed(denied.toUpperCase())).toBe(false);
    expect(await screen!.isAllowed(allowed)).toBe(true);
  });

  it("production + SANCTIONS_REQUIRED=1 + no list -> THROWS (fail-closed, value-free)", () => {
    const env = { NODE_ENV: "production", SANCTIONS_REQUIRED: "1" } as NodeJS.ProcessEnv;
    expect(() => resolvePayerScreen(env)).toThrow(/SANCTIONS_DENYLIST/);
  });

  it("production + SANCTIONS_REQUIRED=1 + only-blank list -> THROWS (empty denylist is no enforcement)", () => {
    const env = {
      NODE_ENV: "production",
      SANCTIONS_REQUIRED: "1",
      SANCTIONS_DENYLIST: "   ,  , ",
    } as NodeJS.ProcessEnv;
    expect(() => resolvePayerScreen(env)).toThrow(/SANCTIONS_DENYLIST/);
  });

  it("dev + no list -> undefined (UNARMED, current behavior preserved)", () => {
    expect(resolvePayerScreen({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeUndefined();
    // Even an empty object (no SANCTIONS_* at all) is unarmed.
    expect(resolvePayerScreen({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("production WITHOUT SANCTIONS_REQUIRED + no list -> undefined (not forced)", () => {
    // Production alone does not force screening; only SANCTIONS_REQUIRED=1 does.
    expect(resolvePayerScreen({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("a list set in production armed regardless of SANCTIONS_REQUIRED", async () => {
    const denied = "0x0000000000000000000000000000000000000abc";
    const env = {
      NODE_ENV: "production",
      SANCTIONS_DENYLIST: denied,
    } as NodeJS.ProcessEnv;
    const screen = resolvePayerScreen(env);
    expect(screen).toBeInstanceOf(InMemoryPayerScreen);
    expect(await screen!.isAllowed(denied)).toBe(false);
  });
});
