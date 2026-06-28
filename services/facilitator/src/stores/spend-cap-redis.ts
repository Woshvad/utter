// The real Redis-backed SpendCapStore adapter (Track A-finish, subtask 1).
//
// HONESTY FLAG: this adapter's COMMAND LOGIC is verified by a faithful-fake
// conformance suite (services/facilitator/test/spend-cap-redis.test.ts) that
// EXECUTES RedisSpendCapStore offline against a hand-rolled ioredis.Redis fake
// (it runs each Lua script's logic in JS), asserting the SAME SpendCapStore
// contract the in-memory adapter satisfies in
// packages/data-proxy/test/spend-cap.test.ts: the rolling-24h window trim, the
// deny-by-default atomic check-and-reserve (including the two-concurrent-over-cap
// TOCTOU case), and the compensating refund of one reserved entry. That suite
// runs in the default test run and needs no Docker/Redis. It is STILL NOT
// verified against LIVE Redis; live behavior is confirmed only when Redis is
// provisioned (operator-gated infra). Logic-verified, not live-infra-verified.
//
// Why the facilitator owns this and not @utter/data-proxy: the data-proxy package
// declares the SpendCapStore interface + the InMemory default but has NO ioredis
// dependency. The facilitator already depends on ioredis and owns its Redis store
// adapters (stores/pgRedis.ts), so this adapter lives here and implements the
// @utter/data-proxy SpendCapStore contract.
//
// Durable structure: one sorted set per payer, key `spendcap:<payer>`, score = the
// spend's epoch-SECONDS `now`, member = `<now>:<seq>:<amount>` where `seq` is a
// per-payer uniqueness counter (INCR `spendcapseq:<payer>`) so two spends at the
// same second never collide, and `amount` is the USDC base-unit decimal string
// recovered as the LAST colon segment of the member.
//
// All three methods are ATOMIC via a single redis.eval Lua script each (trim +
// read/write in one server-side op), mirroring InMemorySpendCapStore's
// no-await-between-check-and-write indivisibility. The trim is
// `ZREMRANGEBYSCORE key -inf (now-WINDOW)` with an EXCLUSIVE `(` lower-open bound,
// so members at score <= cutoff are removed and members at score > cutoff are kept,
// matching InMemory's `e.at > cutoff` keep rule exactly.
//
// MONEY: amounts cross the JS boundary as base-unit bigint. The Lua sums the
// in-window amounts and returns the total as an INTEGER decimal string via
// string.format("%.0f", sum); JS parses it back with BigInt(...). There is NO
// 6/1e6/decimals literal anywhere. PRECISION NOTE: the in-Lua sum/compare uses Lua
// doubles, which are EXACT for integers below 2^53. A per-payer 24h cap and its
// rolling total are far below that (2^53 base units ~ 9e15 ~ $9B at 6dp), so
// realistic caps and totals are exact. The integer-string return avoids Lua's
// tostring emitting scientific notation (e.g. 5e+09) that BigInt(...) would reject.
//
// CLOCK: `now` is injected epoch seconds (the gate's deterministic clock). There is
// NO Date.now() in this adapter, so the window math is fully deterministic under a
// fake clock, exactly like InMemorySpendCapStore.
import { Redis } from "ioredis";
import {
  type SpendCapStore,
  SPEND_CAP_WINDOW_SECONDS,
} from "@utter/data-proxy";

const KEY_PREFIX = "spendcap:"; // per-payer rolling-window ZSET
const SEQ_PREFIX = "spendcapseq:"; // per-payer member-uniqueness counter

// recordSpend(payer, amount, now): trim the window, optionally append this spend,
// refresh the key TTL, and return the new in-window total as an integer string.
//
// KEYS[1] = spendcap:<payer>   KEYS[2] = spendcapseq:<payer>
// ARGV[1] = now (seconds)      ARGV[2] = amount (base-unit decimal string)
// ARGV[3] = window (seconds)
const RECORD_LUA = `
local key = KEYS[1]
local seqkey = KEYS[2]
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local cutoff = now - window
-- Trim spends at score <= cutoff (exclusive upper bound '(' keeps score > cutoff).
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
if amount ~= 0 then
  local seq = redis.call('INCR', seqkey)
  local member = ARGV[1] .. ':' .. seq .. ':' .. ARGV[2]
  redis.call('ZADD', key, now, member)
end
redis.call('EXPIRE', key, window)
local members = redis.call('ZRANGE', key, 0, -1)
local sum = 0
for i = 1, #members do
  local m = members[i]
  -- amount is the LAST colon-delimited segment of '<now>:<seq>:<amount>'.
  local amt = tonumber(string.match(m, '([^:]+)$'))
  sum = sum + amt
end
return string.format('%.0f', sum)
`;

// tryRecordSpend(payer, amount, cap, now): trim, sum the window, and IFF
// sum + amount <= cap append the spend and return {1, sum+amount}; else record
// NOTHING and return {0, sum}. The EXPIRE is refreshed on BOTH paths (so a denied
// then idle payer's residual ZSET still expires).
//
// KEYS[1] = spendcap:<payer>   KEYS[2] = spendcapseq:<payer>
// ARGV[1] = now (seconds)      ARGV[2] = amount   ARGV[3] = cap   ARGV[4] = window
const TRY_RECORD_LUA = `
local key = KEYS[1]
local seqkey = KEYS[2]
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
local members = redis.call('ZRANGE', key, 0, -1)
local sum = 0
for i = 1, #members do
  local amt = tonumber(string.match(members[i], '([^:]+)$'))
  sum = sum + amt
end
-- Deny-by-default: only reserve when the spend stays within the cap. The check and
-- the ZADD are in this single atomic EVAL, so two concurrent jointly-over-cap calls
-- cannot both pass (the second sees the first's reservation).
if sum + amount > cap then
  redis.call('EXPIRE', key, window)
  return {0, string.format('%.0f', sum)}
end
if amount ~= 0 then
  local seq = redis.call('INCR', seqkey)
  local member = ARGV[1] .. ':' .. seq .. ':' .. ARGV[2]
  redis.call('ZADD', key, now, member)
end
redis.call('EXPIRE', key, window)
return {1, string.format('%.0f', sum + amount)}
`;

// refundSpend(payer, amount, now): trim, then among members at score == now remove
// the FIRST whose parsed amount == amount (mirrors InMemory removing ONE matching
// (amount, at) entry), refresh the TTL, and return the new in-window total.
//
// KEYS[1] = spendcap:<payer>
// ARGV[1] = now (seconds)   ARGV[2] = amount   ARGV[3] = window
const REFUND_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
-- Members at exactly score == now are the candidates (same timestamp as the hold).
local atNow = redis.call('ZRANGEBYSCORE', key, now, now)
for i = 1, #atNow do
  local m = atNow[i]
  local amt = tonumber(string.match(m, '([^:]+)$'))
  if amt == amount then
    redis.call('ZREM', key, m)
    break
  end
end
redis.call('EXPIRE', key, window)
local members = redis.call('ZRANGE', key, 0, -1)
local sum = 0
for i = 1, #members do
  sum = sum + tonumber(string.match(members[i], '([^:]+)$'))
end
return string.format('%.0f', sum)
`;

/**
 * Redis-backed SpendCapStore over an injected ioredis client. Honors the IDENTICAL
 * SpendCapStore contract InMemorySpendCapStore satisfies (rolling-window trim + sum,
 * atomic deny-by-default check-and-reserve, refund of one reserved entry), with all
 * window math on the INJECTED `now` (never Date.now()). Money stays exact base-unit
 * bigint at the JS boundary (the Lua returns an integer decimal string).
 */
export class RedisSpendCapStore implements SpendCapStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async recordSpend(payer: string, amount: bigint, now: number): Promise<bigint> {
    const raw = (await this.redis.eval(
      RECORD_LUA,
      2,
      `${KEY_PREFIX}${payer}`,
      `${SEQ_PREFIX}${payer}`,
      String(now),
      amount.toString(),
      String(SPEND_CAP_WINDOW_SECONDS),
    )) as string;
    return BigInt(raw);
  }

  async tryRecordSpend(
    payer: string,
    amount: bigint,
    cap: bigint,
    now: number,
  ): Promise<{ allowed: boolean; total: bigint }> {
    const res = (await this.redis.eval(
      TRY_RECORD_LUA,
      2,
      `${KEY_PREFIX}${payer}`,
      `${SEQ_PREFIX}${payer}`,
      String(now),
      amount.toString(),
      cap.toString(),
      String(SPEND_CAP_WINDOW_SECONDS),
    )) as [number, string];
    return { allowed: res[0] === 1, total: BigInt(res[1]) };
  }

  async refundSpend(payer: string, amount: bigint, now: number): Promise<bigint> {
    const raw = (await this.redis.eval(
      REFUND_LUA,
      1,
      `${KEY_PREFIX}${payer}`,
      String(now),
      amount.toString(),
      String(SPEND_CAP_WINDOW_SECONDS),
    )) as string;
    return BigInt(raw);
  }

  /** Quit the ioredis client (clean teardown for tests + operator shutdown). */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Build a Redis-backed SpendCapStore from a connection URL (mirrors
 * createPgRedisStores). The URL is never logged. Returns the store typed as the
 * shared SpendCapStore contract so server.ts swaps adapters by env without touching
 * the gate logic. Behavior is logic-verified offline (see the file header), not yet
 * live-infra-verified.
 */
export function createRedisSpendCapStore(redisUrl: string): SpendCapStore {
  return new RedisSpendCapStore(new Redis(redisUrl));
}
