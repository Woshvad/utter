// The durable Redis-backed deployer store adapter (DEP-03/04, M5).
//
// HONESTY FLAG: this adapter's COMMAND LOGIC is verified by a faithful-fake
// conformance suite (services/deployer/test/redis-stores.test.ts) that EXECUTES
// RedisDeploymentStore + RedisResponseCache offline against a hand-rolled
// ioredis.Redis fake, asserting the SAME DeploymentStore / ResponseCache contract
// the in-memory adapter satisfies: the atomic Lua slug-claim (cross-resourceId
// reuse throws SlugConflictError; same-resourceId re-put is idempotent; an own-slug
// change frees the old reverse-index key), the cap bigint round-trip as a base-unit
// string, and the cache TTL + prefix-scoped invalidation. That suite runs in the
// default test run and needs no Docker/Redis. It is STILL NOT verified against a
// LIVE Redis; live behavior is confirmed only when Redis is provisioned (operator-
// gated infra). Logic-verified, not live-infra-verified. The in-memory adapter
// (createInMemoryStores) remains the test/dev default.
//
// Keys (all under the deploy: namespace):
//   - deploy:rec:<resourceId>  -> JSON of the DeploymentRecord (cap as a base-unit
//                                 STRING, never a JS number, so a USDC amount loses
//                                 no precision and carries no decimals literal).
//   - deploy:slug:<slug>       -> the owning resourceId (the M5 reverse index).
//   - deploy:all               -> a SET of every resourceId for list().
//
// The slug-claim is made ATOMIC by a single Lua eval (the store-interface doc
// endorses Lua): the check (is the slug held by a different resourceId?) and the
// claim (write the rec, claim the slug, free a changed old slug, SADD to deploy:all)
// run in ONE server-side script with no interleaving, so two concurrent puts cannot
// both pass the check.
import { Redis } from "ioredis";
import type { Hex } from "viem";
import {
  type DeploymentStore,
  type DeploymentRecord,
  type ResponseCache,
  type DeployerStores,
  SlugConflictError,
} from "./memory";

const REC_PREFIX = "deploy:rec:"; // resourceId -> record JSON
const SLUG_PREFIX = "deploy:slug:"; // slug -> owning resourceId (M5 reverse index)
const ALL_SET = "deploy:all"; // SET of resourceIds for list()

/** The JSON shape persisted at deploy:rec:<id>. cap is a base-unit string (or absent). */
interface SerializedRecord {
  agentId: Hex;
  resourceId: Hex;
  slug: string;
  deployVersion: number;
  status: DeploymentRecord["status"];
  updatedAt: number;
  /** USDC base units as a string; never a JS number (no precision loss). */
  cap?: string;
}

function serialize(record: DeploymentRecord): string {
  const out: SerializedRecord = {
    agentId: record.agentId,
    resourceId: record.resourceId,
    slug: record.slug,
    deployVersion: record.deployVersion,
    status: record.status,
    updatedAt: record.updatedAt,
    cap: record.cap !== undefined ? record.cap.toString() : undefined,
  };
  return JSON.stringify(out);
}

function deserialize(raw: string): DeploymentRecord {
  const parsed = JSON.parse(raw) as SerializedRecord;
  return {
    agentId: parsed.agentId,
    resourceId: parsed.resourceId,
    slug: parsed.slug,
    deployVersion: parsed.deployVersion,
    status: parsed.status,
    updatedAt: parsed.updatedAt,
    // String -> bigint at the boundary, matching the in-memory adapter's cap type.
    cap: parsed.cap !== undefined ? BigInt(parsed.cap) : undefined,
  };
}

// The atomic slug-claim script. ARGV: [resourceId, slug, recJson, slugPrefix,
// recPrefix, allSet]. Behavior mirrors InMemoryDeploymentStore.put EXACTLY:
//   1. If deploy:slug:<slug> is held by a DIFFERENT resourceId -> return the
//      conflict signal {1, existingOwner} and mutate NOTHING (the original owner's
//      record stays byte-for-byte unchanged and resolvable).
//   2. If this resourceId already held a DIFFERENT slug (an own-slug change), DEL
//      the stale deploy:slug:<oldSlug> reverse-index entry so the freed slug is not
//      falsely reserved.
//   3. Write the rec JSON, claim deploy:slug:<slug> -> resourceId, SADD the
//      resourceId to deploy:all. A same-resourceId same-slug re-put is idempotent
//      (the reverse index is unchanged) and never signals a conflict (DEP-04).
// The script returns {0} on success and {1, existingOwner} on a slug conflict; the
// adapter throws SlugConflictError on the {1, ...} signal.
const SLUG_CLAIM_SCRIPT = `
local resourceId = ARGV[1]
local slug = ARGV[2]
local recJson = ARGV[3]
local slugPrefix = ARGV[4]
local recPrefix = ARGV[5]
local allSet = ARGV[6]

local slugKey = slugPrefix .. slug
local existingOwner = redis.call('GET', slugKey)
if existingOwner and existingOwner ~= resourceId then
  return {1, existingOwner}
end

local recKey = recPrefix .. resourceId
local prevRaw = redis.call('GET', recKey)
if prevRaw then
  local prev = cjson.decode(prevRaw)
  if prev.slug and prev.slug ~= slug then
    redis.call('DEL', slugPrefix .. prev.slug)
  end
end

redis.call('SET', recKey, recJson)
redis.call('SET', slugKey, resourceId)
redis.call('SADD', allSet, resourceId)
return {0}
`;

/**
 * Redis-backed DeploymentStore. The slug-claim runs as a single Lua eval so the
 * check and the claim are atomic (two concurrent puts cannot both pass), matching
 * the M5 guarantee the in-memory adapter gives synchronously.
 */
export class RedisDeploymentStore implements DeploymentStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async put(record: DeploymentRecord): Promise<void> {
    const result = (await this.redis.eval(
      SLUG_CLAIM_SCRIPT,
      0,
      record.resourceId,
      record.slug,
      serialize(record),
      SLUG_PREFIX,
      REC_PREFIX,
      ALL_SET,
    )) as [number, string?];
    // The script signals a cross-resourceId slug conflict as {1, existingOwner}.
    if (result[0] === 1) {
      const existingOwner = result[1] as Hex;
      throw new SlugConflictError(record.slug, existingOwner, record.resourceId);
    }
  }

  async get(resourceId: Hex): Promise<DeploymentRecord | null> {
    const raw = await this.redis.get(`${REC_PREFIX}${resourceId}`);
    return raw ? deserialize(raw) : null;
  }

  async getBySlug(slug: string): Promise<DeploymentRecord | null> {
    const resourceId = await this.redis.get(`${SLUG_PREFIX}${slug}`);
    if (resourceId === null) return null;
    return this.get(resourceId as Hex);
  }

  async list(): Promise<DeploymentRecord[]> {
    const resourceIds = await this.redis.smembers(ALL_SET);
    if (resourceIds.length === 0) return [];
    const recKeys = resourceIds.map((id) => `${REC_PREFIX}${id}`);
    const raws = await this.redis.mget(...recKeys);
    // MGET returns null for any rec that is gone; skip those so list() never yields
    // a hole (a resourceId in the SET whose rec key was evicted).
    return raws.filter((r): r is string => r !== null).map(deserialize);
  }
}

/**
 * Redis-backed ResponseCache. set uses SET PX so ioredis returns null past the TTL
 * (server-side expiry, no sweeper). delByPrefix uses a BOUNDED SCAN cursor loop +
 * DEL over <prefix>* (NEVER a blocking KEYS).
 */
export class RedisResponseCache implements ResponseCache {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, body: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, body, "PX", ttlSeconds * 1000);
  }

  async delByPrefix(prefix: string): Promise<void> {
    // Bounded SCAN cursor loop (MATCH <prefix>*), DEL each batch. SCAN is cursor-
    // paginated so it never blocks the server the way KEYS would on a large keyspace.
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== "0");
  }
}

/** Options for wiring the Redis-backed deployer stores from env (REDIS_URL). */
export interface RedisStoreOptions {
  redisUrl: string;
}

/**
 * Build the durable Redis-backed deployer stores. Exposes the same DeployerStores
 * shape as createInMemoryStores, so server.ts swaps adapters by env without
 * touching the deploy/cache logic. The Redis client is constructed here from
 * redisUrl (which may carry credentials and is NEVER logged). Behavior-unverified
 * against live Redis (see file header); logic-verified via the faithful-fake suite.
 */
export function createRedisStores(opts: RedisStoreOptions): DeployerStores {
  const redis = new Redis(opts.redisUrl);
  return {
    deployments: new RedisDeploymentStore(redis),
    cache: new RedisResponseCache(redis),
    // Teardown for graceful shutdown: quit the single shared redis client (the
    // deployment store + response cache share it). Called only after the request drain.
    close: async () => {
      await redis.quit();
    },
    // Readiness probe for GET /ready: a cheap read-only PING over the same redis client
    // the stores use. It never writes and never touches the deployment records, so it
    // cannot perturb deploy/cache logic; a throw here turns /ready into a value-free 503.
    probe: async () => {
      await redis.ping();
    },
  };
}
