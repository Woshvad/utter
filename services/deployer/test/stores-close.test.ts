// stores-close.test.ts - the per-service teardown DoD for the deployer
// (Provisioning track, subtask 3).
//
// Asserts the close() seam createRedisStores returns quits the single shared redis
// client (redis.quit), and that the in-memory default exposes NO close (so graceful
// shutdown skips it and dev/test boot is byte-unchanged).
//
// OFFLINE: the factory constructs a real ioredis.Redis against a NON-ROUTABLE URL, but
// no real connection is ever made. We spy on Redis.prototype.quit so close() is observed
// WITHOUT touching live infra; the spy resolves immediately so the worker leaves no open
// handle.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Redis } from "ioredis";
import { createRedisStores } from "../src/stores/redis";
import { createInMemoryStores } from "../src/stores/memory";

const FAKE_REDIS = "redis://127.0.0.1:1";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deployer createRedisStores().close()", () => {
  it("quits the shared redis client (redis.quit)", async () => {
    const quitSpy = vi.spyOn(Redis.prototype, "quit").mockResolvedValue("OK");

    const stores = createRedisStores({ redisUrl: FAKE_REDIS });
    expect(typeof stores.close).toBe("function");
    await stores.close!();

    expect(quitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("deployer createInMemoryStores().close", () => {
  it("exposes no close (graceful shutdown skips it; dev/test boot byte-unchanged)", () => {
    const stores = createInMemoryStores();
    expect(stores.close).toBeUndefined();
  });
});
