// resolveDeployerStores: env-driven store selection with production fail-closed on
// durability. Mirrors the facilitator's resolveAuthConfig fail-closed test discipline.
//
// REDIS_URL set + non-empty -> the durable Redis-backed adapter (assert by the store
// class, WITHOUT issuing a real Redis command). NODE_ENV=production + no REDIS_URL ->
// THROW at boot (never silently ephemeral in prod). Dev/test + no REDIS_URL ->
// in-memory (the autonomous suite needs no Redis).
//
// No real Redis traffic: when REDIS_URL is set, createRedisStores constructs an
// ioredis client that begins connecting in the background. We never issue a command,
// and we DISCONNECT the client at the end of the test so there is no open handle and
// no connection-refused noise (the URL points at a non-routing host).
import { describe, it, expect } from "vitest";
import type { Redis } from "ioredis";
import { resolveDeployerStores } from "../src/server";
import { RedisDeploymentStore, RedisResponseCache } from "../src/stores/redis";
import {
  InMemoryDeploymentStore,
  InMemoryResponseCache,
} from "../src/stores/memory";

/** A private-range host that does not route, so no connection ever establishes. */
const NON_ROUTING_REDIS_URL = "redis://10.255.255.1:6379";

describe("resolveDeployerStores (env-driven selection, prod fail-closed)", () => {
  it("REDIS_URL set -> the durable Redis-backed adapter (no real command issued)", () => {
    const stores = resolveDeployerStores({
      REDIS_URL: NON_ROUTING_REDIS_URL,
    } as NodeJS.ProcessEnv);
    try {
      expect(stores.deployments).toBeInstanceOf(RedisDeploymentStore);
      expect(stores.cache).toBeInstanceOf(RedisResponseCache);
    } finally {
      // Tear down the constructed ioredis clients so there is no open handle. Each
      // store holds its own client; disconnect() drops the socket without flushing.
      const depRedis = (stores.deployments as unknown as { redis: Redis }).redis;
      const cacheRedis = (stores.cache as unknown as { redis: Redis }).redis;
      depRedis.disconnect();
      cacheRedis.disconnect();
    }
  });

  it("NODE_ENV=production + no REDIS_URL -> throws (fail-closed on durability)", () => {
    expect(() =>
      resolveDeployerStores({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL must be set in production/);
  });

  it("a blank REDIS_URL in production still throws (whitespace is not a value)", () => {
    expect(() =>
      resolveDeployerStores({
        NODE_ENV: "production",
        REDIS_URL: "   ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL must be set in production/);
  });

  it("dev/test + no REDIS_URL -> the in-memory default", () => {
    const stores = resolveDeployerStores({} as NodeJS.ProcessEnv);
    expect(stores.deployments).toBeInstanceOf(InMemoryDeploymentStore);
    expect(stores.cache).toBeInstanceOf(InMemoryResponseCache);
  });

  it("the production throw never echoes the (missing/blank) REDIS_URL value", () => {
    try {
      resolveDeployerStores({
        NODE_ENV: "production",
        REDIS_URL: "   ",
      } as NodeJS.ProcessEnv);
      throw new Error("expected a throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The error is value-free: it names the env var, never its (blank) contents.
      expect(msg).not.toContain("   ");
      expect(msg).toContain("REDIS_URL");
    }
  });
});
