// browse.server.ts - the public browse-loader protections (S9).
//
// The discover, creator-profile, and resource-detail loaders are anonymous O(N)
// fan-outs (a marketplace list read plus per-card detail/revenue reads). Controls:
//   - a shared per-IP fixed-window limiter (BROWSE_LIMIT_PER_IP_PER_MIN, default
//     60/min) that throws a 429 Response from the loader (error boundary renders;
//     this is an abuse-only path);
//   - a GLOBAL backstop window (BROWSE_LIMIT_GLOBAL_PER_MIN, default 600/min) keyed
//     on the literal "global", so an attacker who rotates source addresses to mint
//     fresh per-IP buckets (a routed IPv6 /56-/48 yields hundreds-to-thousands of
//     /64 keys) still cannot amplify the marketplace/facilitator fan-out past the
//     platform-wide ceiling. Both windows are peeked first and committed only when
//     both allow, so a denied request increments neither;
//   - a tiny 30s TTL memo around the shared marketplace list read, so anonymous
//     hits cannot amplify into marketplace/facilitator fan-out load. The memo also
//     dedupes concurrent identical reads (the in-flight promise is shared) and
//     never caches a rejected read.
import type { FilterCriteria } from "@utter/marketplace";
import type { ResourceCardData, StudioDataAdapter } from "../adapter/types.js";
import { FixedWindowLimiter, parsePositiveInt } from "./fixed-window.server.js";
import { clientIpKey } from "./client-ip.server.js";

/** The shared browse limiters (module singletons, lazy so env is read at first use):
 *  a per-IP window and a global platform-wide backstop. */
let browseLimiter: FixedWindowLimiter | undefined;
let globalLimiter: FixedWindowLimiter | undefined;

function limiter(): FixedWindowLimiter {
  if (!browseLimiter) {
    browseLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(
        process.env.BROWSE_LIMIT_PER_IP_PER_MIN,
        60,
        "BROWSE_LIMIT_PER_IP_PER_MIN",
      ),
      windowMs: 60_000,
    });
  }
  return browseLimiter;
}

function global(): FixedWindowLimiter {
  if (!globalLimiter) {
    globalLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(
        process.env.BROWSE_LIMIT_GLOBAL_PER_MIN,
        600,
        "BROWSE_LIMIT_GLOBAL_PER_MIN",
      ),
      windowMs: 60_000,
    });
  }
  return globalLimiter;
}

/** Build the 429 deny Response the browse loaders throw. */
function rateLimited(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfterMs }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    },
  );
}

/**
 * Enforce the per-IP AND global browse limits for a public loader. Peeks both
 * windows first and throws a 429 JSON Response (with Retry-After) if either denies;
 * commits one hit to both only when both allow (a denied request increments
 * neither).
 */
export function checkBrowseLimit(request: Request): void {
  const perIp = limiter();
  const glob = global();
  const key = clientIpKey(request);
  const ipVerdict = perIp.peek(key);
  if (!ipVerdict.allowed) throw rateLimited(ipVerdict.retryAfterMs);
  const globalVerdict = glob.peek("global");
  if (!globalVerdict.allowed) throw rateLimited(globalVerdict.retryAfterMs);
  perIp.commit(key);
  glob.commit("global");
}

/** How long a memoized list read stays fresh. Constant by design (no env knob). */
const LIST_MEMO_TTL_MS = 30_000;

/** Hard cap on distinct memoized criteria so a query-string spray stays bounded. */
const LIST_MEMO_MAX_ENTRIES = 64;

interface MemoEntry {
  at: number;
  value: Promise<ResourceCardData[]>;
}

const listMemo = new Map<string, MemoEntry>();
let memoNow: () => number = () => Date.now();

/** A stable string key for a FilterCriteria (bigint-safe). */
function criteriaKey(criteria: FilterCriteria): string {
  return JSON.stringify(criteria, (_k, v: unknown) =>
    typeof v === "bigint" ? `${v.toString()}n` : v,
  );
}

/**
 * The memoized marketplace list read the browse loaders share. Returns a SHALLOW
 * COPY of the cached array on every call so a caller's filter/sort can never
 * reorder or mutate the shared cache.
 */
export function memoListMarketplace(
  adapter: StudioDataAdapter,
  criteria: FilterCriteria,
): Promise<ResourceCardData[]> {
  const key = criteriaKey(criteria);
  const now = memoNow();
  const hit = listMemo.get(key);
  if (hit && now - hit.at < LIST_MEMO_TTL_MS) {
    return hit.value.then((cards) => cards.slice());
  }
  if (listMemo.size >= LIST_MEMO_MAX_ENTRIES) {
    // Drop stale entries first; if every entry is fresh, drop the oldest.
    for (const [k, entry] of listMemo) {
      if (now - entry.at >= LIST_MEMO_TTL_MS) listMemo.delete(k);
    }
    if (listMemo.size >= LIST_MEMO_MAX_ENTRIES) {
      const oldest = listMemo.keys().next().value as string | undefined;
      if (oldest !== undefined) listMemo.delete(oldest);
    }
  }
  const value = adapter.listMarketplace(criteria);
  const entry: MemoEntry = { at: now, value };
  listMemo.set(key, entry);
  // Never cache a failure: the next request must retry the real read.
  value.catch(() => {
    if (listMemo.get(key) === entry) listMemo.delete(key);
  });
  return value.then((cards) => cards.slice());
}

/**
 * Invalidate the marketplace list memo. Called from the publish path (a create's
 * marketplace publish) so a just-listed resource appears on /discover and the
 * creator profile immediately, instead of being hidden for up to the 30s TTL behind
 * a memo entry an anonymous visitor warmed. Clearing every criteria key is correct:
 * a new listing can match any filter, and the memo repopulates on the next read.
 */
export function invalidateListMemo(): void {
  listMemo.clear();
}

/**
 * Test-only reset: clears both limiters (recreated from env on next use) and the
 * memo, and installs the given memo clock (the real clock when omitted, so an
 * injected test clock never leaks into a later test).
 */
export function resetBrowseStateForTests(now?: () => number): void {
  browseLimiter = undefined;
  globalLimiter = undefined;
  listMemo.clear();
  memoNow = now ?? (() => Date.now());
}
