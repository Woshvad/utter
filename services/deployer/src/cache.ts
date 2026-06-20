// cache.ts - the response cache: normalized key + billable DISCLOSED hit (DEP-03).
//
// THE MONEY-PATH INVARIANT (RESEARCH Pitfall 3): the cache lookup happens AFTER the
// gate's `/verify` has RESERVED the cap. A HIT therefore skips the container HANDLER
// but is STILL a real, disclosed, billable call: `getOrInvoke` fires
// `recordBillableCall({cached:true})` on every hit and discloses `X-Cache: HIT`. A
// hit NEVER bypasses billing - it only bypasses re-running the (deterministic)
// handler. This is the load-bearing guard against the free-call bypass (T-03-20).
//
// Key shape (RESEARCH Pattern 4 / Code Ex §5):
//   resource:<resourceId>:v<deployVersion>:sha256(method\npath\ncanon(query)\ncanon(body))
// `canon` sorts object keys + normalizes whitespace so semantically-identical
// requests collapse to one key. The `v<deployVersion>` namespace means a redeploy
// bump (DEP-04) makes ALL old-version keys unreachable -> atomic cache invalidation.
//
// Backend: the in-memory `ResponseCache` is the TEST DEFAULT (Phase 2 adapter
// pattern). The prod path is `ioredis` implementing the SAME `ResponseCache`
// interface (get / set EX), so this exact `getOrInvoke` runs unchanged against
// live Redis - only the adapter swaps at bootstrap.
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { ResponseCache } from "./stores/memory";

/** The normalized request shape the cache key is derived from. */
export interface CachedRequest {
  /** HTTP method (uppercased in the key). */
  method: string;
  /** Request path (no query string). */
  path: string;
  /** Query params (key order irrelevant - canonicalized). */
  query?: Record<string, string>;
  /** Request body (JSON string; whitespace-normalized when parseable). */
  body?: string;
}

/** A disclosed billable-call record (the accounting hook payload). */
export interface BillableCall {
  /** The resource charged (the escrow payTo / splitter target). */
  resourceId: Hex;
  /** The idempotency key for this call (the escrow nonce). */
  idemKey: string;
  /** True when this call was served from cache (disclosed, still billed). */
  cached: boolean;
}

/** The accounting hook the money path fires for EVERY billable call (hit or miss). */
export type RecordBillableCall = (call: BillableCall) => void | Promise<void>;

/**
 * Canonicalize a value for the cache key: sort object keys recursively and
 * normalize whitespace, so `{a,b}` and `{b,a}` (and `{ "x" : 1 }` vs `{"x":1}`)
 * collapse to one key. A non-JSON string is whitespace-trimmed verbatim.
 */
function canon(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      return canon(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the normalized + deploy-version-namespaced cache key:
 *   `resource:<resourceId>:v<deployVersion>:<sha256(method\npath\ncanon(query)\ncanon(body))>`.
 * Stable under query/body key reordering + whitespace; a deployVersion bump changes
 * the namespace so old-version keys become unreachable (atomic invalidation, DEP-04).
 */
export function cacheKey(
  resourceId: Hex,
  deployVersion: number,
  req: CachedRequest,
): string {
  const material = [
    req.method.toUpperCase(),
    req.path,
    canon(req.query ?? {}),
    canon(req.body ?? ""),
  ].join("\n");
  const hash = createHash("sha256").update(material).digest("hex");
  return `resource:${resourceId}:v${deployVersion}:${hash}`;
}

/** The result of a cache-mediated invocation. */
export interface GetOrInvokeResult {
  /** The response body (cached or freshly computed). */
  body: string;
  /** True if served from cache (disclosed via X-Cache: HIT). */
  cached: boolean;
  /** Response headers to merge - always carries the X-Cache disclosure. */
  headers: Record<string, string>;
}

/** Options for {@link getOrInvoke}. */
export interface GetOrInvokeOpts {
  /** The cache backend (in-memory test default; ioredis in prod - same interface). */
  cache: ResponseCache;
  /** The resource being charged. */
  resourceId: Hex;
  /** The current deploy version (the cache namespace). */
  deployVersion: number;
  /** The normalized request. */
  req: CachedRequest;
  /** The card TTL for the cached body (seconds). */
  ttlSeconds: number;
  /** Run the sandboxed handler (called ONLY on a miss). */
  invoke: () => Promise<string>;
  /** The accounting hook - fires on EVERY call (hit or miss), never skipped on a hit. */
  recordBillableCall: RecordBillableCall;
  /** This call's idempotency key (the escrow nonce). */
  idemKey: string;
}

/**
 * Serve a response through the cache (DEP-03). The cache lookup runs AFTER the gate
 * reserved the cap, so the call is ALREADY a real billable call:
 *   - HIT: fire `recordBillableCall({cached:true})`, return the cached body with
 *     `X-Cache: HIT`, and SKIP `invoke` (the handler never re-runs);
 *   - MISS: call `invoke`, store the body under the normalized+versioned key with
 *     `ttlSeconds`, fire `recordBillableCall({cached:false})`, return `X-Cache: MISS`.
 *
 * THE INVARIANT: a returned body ALWAYS coincides with exactly one billing record -
 * a hit skips the handler, never the billing (Pitfall 3, no free bypass).
 */
export async function getOrInvoke(opts: GetOrInvokeOpts): Promise<GetOrInvokeResult> {
  const key = cacheKey(opts.resourceId, opts.deployVersion, opts.req);
  const hit = await opts.cache.get(key);

  if (hit !== null) {
    // A HIT is a disclosed billable call: the hook fires BEFORE we return the body,
    // so there is no code path that returns a cached body without billing.
    await opts.recordBillableCall({
      resourceId: opts.resourceId,
      idemKey: opts.idemKey,
      cached: true,
    });
    return { body: hit, cached: true, headers: { "X-Cache": "HIT" } };
  }

  // MISS: run the handler, persist for the TTL, bill the (uncached) call.
  const body = await opts.invoke();
  await opts.cache.set(key, body, opts.ttlSeconds);
  await opts.recordBillableCall({
    resourceId: opts.resourceId,
    idemKey: opts.idemKey,
    cached: false,
  });
  return { body, cached: false, headers: { "X-Cache": "MISS" } };
}

/** An in-memory billing log: the default {@link RecordBillableCall} for tests / dev. */
export interface InMemoryBillingLog {
  /** The recorded billable calls in order. */
  calls: BillableCall[];
  /** The {@link RecordBillableCall} hook appending to {@link calls}. */
  record: RecordBillableCall;
}

/**
 * Build an in-memory billing log (the assertable accounting hook for tests). The
 * prod hook persists to the payment ledger / metering store; this default just
 * records to an array so a test can assert the hook fired (and with `cached:true`
 * on a hit). The hook is injectable into `getOrInvoke`, so prod swaps it for the
 * real ledger writer without changing the cache logic.
 */
export function createInMemoryBillingLog(): InMemoryBillingLog {
  const calls: BillableCall[] = [];
  return {
    calls,
    record: (call) => {
      calls.push(call);
    },
  };
}

/** The default accounting hook (in-memory; prod injects the ledger writer). */
export const recordBillableCall: RecordBillableCall = createInMemoryBillingLog().record;
