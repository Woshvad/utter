// stores-close.test.ts - the per-service teardown DoD for the facilitator
// (Provisioning track, subtask 3).
//
// Asserts the close() seam createPgRedisStores returns actually drains the pg pool
// (pg.end) AND quits the redis client (redis.quit), and that the in-memory default
// exposes NO close (so graceful shutdown skips it and dev/test boot is byte-unchanged).
//
// OFFLINE: the factory constructs real pg.Pool / ioredis.Redis against NON-ROUTABLE
// URLs, but no real connection is ever made. We spy on Pool.prototype.end and
// Redis.prototype.quit so close() is observed WITHOUT touching live infra; the spies
// resolve immediately so the worker leaves no open handle.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { createPgRedisStores } from "../src/stores/pgRedis";
import { createInMemoryStores } from "../src/stores/memory";

const FAKE_PG = "postgresql://u:p@127.0.0.1:1/db";
const FAKE_REDIS = "redis://127.0.0.1:1";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("facilitator createPgRedisStores().close()", () => {
  it("drains the pg pool (pg.end) and quits the redis client (redis.quit)", async () => {
    const endSpy = vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);
    const quitSpy = vi.spyOn(Redis.prototype, "quit").mockResolvedValue("OK");

    const stores = createPgRedisStores({ databaseUrl: FAKE_PG, redisUrl: FAKE_REDIS });
    expect(typeof stores.close).toBe("function");
    await stores.close!();

    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(quitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("facilitator createInMemoryStores().close", () => {
  it("exposes no close (graceful shutdown skips it; dev/test boot byte-unchanged)", () => {
    const stores = createInMemoryStores();
    expect(stores.close).toBeUndefined();
  });
});
