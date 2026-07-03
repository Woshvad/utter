// resources.$id.events.ts - the STU-02 SSE build-stream resource route.
//
// A React Router v7 framework-mode RESOURCE route (a loader only, no default
// component). It returns a Response whose body is a hand-rolled native
// ReadableStream with Content-Type text/event-stream (06-RESEARCH.md Pattern 1 -
// NOT remix-utils, which needs RR v8). The stream drains
// adapter.subscribeBuildEvents(resourceId) - the six pipeline stages
// Generate -> Deploy -> Verify -> Mint -> Publish -> Live - and enqueues one
// `event: stage` SSE frame per BuildEvent.
//
// T-06-SSE-LEAK (S7): a single lifetime AbortController is aborted by (1) the
// client disconnect (request.signal), (2) the ReadableStream cancel() callback,
// and (3) an unref'd max-lifetime timer (SSE_MAX_LIFETIME_S, default 15 min). Its
// signal is passed INTO adapter.subscribeBuildEvents so a parked live-channel
// reader returns instead of parking forever - the underlying generator is never
// leaked. On top of that, a per-IP open limit (SSE_LIMIT_PER_IP_PER_MIN, default
// 30/min) rejects an open spray with 429, and a channel-at-capacity condition
// surfaces as a PRE-STREAM 503 (the adapter's subscribe admission check runs
// synchronously, before the Response exists).
//
// T-06-PARAM: params.id is validated (isSafeParam, the card-route.ts idiom) before
// it reaches the adapter, so a crafted param cannot reach the source.
import type { LoaderFunctionArgs } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import { BuildChannelAtCapacityError } from "../adapter/build-channel.js";
import type { BuildEvent } from "../adapter/types.js";
import { FixedWindowLimiter, parsePositiveInt } from "../limits/fixed-window.server.js";
import { clientIpKey } from "../limits/client-ip.server.js";

/** A bounded, safe resourceId param (decode-before-use, ASVS V5 - card-route.ts). */
function isSafeParam(value: string | undefined): value is string {
  // resourceIds are short 0x-hex / alnum-hyphen slugs. Reject anything else so a
  // crafted param cannot reach the adapter as a path-traversal or oversized key.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/** The per-IP SSE open limiter (module singleton, lazy so env is read at first use). */
let sseLimiter: FixedWindowLimiter | undefined;

function limiter(): FixedWindowLimiter {
  if (!sseLimiter) {
    sseLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(process.env.SSE_LIMIT_PER_IP_PER_MIN, 30, "SSE_LIMIT_PER_IP_PER_MIN"),
      windowMs: 60_000,
    });
  }
  return sseLimiter;
}

/** The max stream lifetime in ms (SSE_MAX_LIFETIME_S, default 15 minutes). */
function maxLifetimeMs(): number {
  return parsePositiveInt(process.env.SSE_MAX_LIFETIME_S, 900, "SSE_MAX_LIFETIME_S") * 1000;
}

// Per-IP + global CONCURRENT open-stream counters. The open-RATE limit above bounds
// how fast an IP opens streams, NOT how many it holds AT ONCE - and an SSE stream
// lives up to 15 min while holding a BuildChannel entry + a parked reader. Without a
// concurrency cap, one or two IPs opening the allowed 30/min for 15 min accumulate
// ~450 held streams each and pin the global 500-entry BuildChannel hard cap, so every
// real creator's build stream then 503s. These counters cap concurrency per IP and
// platform-wide, well under that hard cap.
const concurrentByIp = new Map<string, number>();
let concurrentGlobal = 0;

function maxConcurrentPerIp(): number {
  return parsePositiveInt(process.env.SSE_MAX_CONCURRENT_PER_IP, 5, "SSE_MAX_CONCURRENT_PER_IP");
}

function maxConcurrentGlobal(): number {
  return parsePositiveInt(process.env.SSE_MAX_CONCURRENT_GLOBAL, 200, "SSE_MAX_CONCURRENT_GLOBAL");
}

/**
 * Reserve a concurrent-stream slot for ipKey. Returns an idempotent release on
 * success, or null when the per-IP or global concurrency cap is already reached (the
 * caller returns 429). The release decrements both counters exactly once and drops
 * the per-IP map entry at zero so the map stays bounded by the number of active IPs.
 */
function acquireStreamSlot(ipKey: string): (() => void) | null {
  const perIp = concurrentByIp.get(ipKey) ?? 0;
  if (perIp >= maxConcurrentPerIp()) return null;
  if (concurrentGlobal >= maxConcurrentGlobal()) return null;
  concurrentByIp.set(ipKey, perIp + 1);
  concurrentGlobal += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    concurrentGlobal -= 1;
    const n = (concurrentByIp.get(ipKey) ?? 1) - 1;
    if (n <= 0) concurrentByIp.delete(ipKey);
    else concurrentByIp.set(ipKey, n);
  };
}

/** Test-only reset so a test's concurrent-stream counters never leak into the next. */
export function resetSseConcurrencyForTests(): void {
  concurrentByIp.clear();
  concurrentGlobal = 0;
  sseLimiter = undefined;
}

/**
 * Stream the build pipeline for a resource as Server-Sent Events. Each BuildEvent
 * is emitted as an `event: stage` frame with the JSON event as `data`. The stream
 * closes when the source generator completes, the client aborts (request.signal or
 * cancel()), or the max lifetime elapses.
 */
export async function loader({ params, request }: LoaderFunctionArgs): Promise<Response> {
  if (!isSafeParam(params.id)) {
    return new Response(JSON.stringify({ error: "bad_resource" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const resourceId = params.id;

  // Per-IP open limit: an SSE connection holds a stream entry and a parked reader,
  // so an open spray is bounded here before anything is subscribed.
  const l = limiter();
  const ipKey = clientIpKey(request);
  const verdict = l.peek(ipKey);
  if (!verdict.allowed) {
    return new Response(
      JSON.stringify({ error: "rate_limited", retryAfterMs: verdict.retryAfterMs }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
        },
      },
    );
  }
  l.commit(ipKey);

  // Concurrency cap: bound how many streams this IP (and the platform) hold at once,
  // reserved BEFORE subscribing so a rejection creates no channel entry. Released on
  // every terminal path (subscribe failure, drain finally, cancel).
  const releaseStreamSlot = acquireStreamSlot(ipKey);
  if (!releaseStreamSlot) {
    return new Response(
      JSON.stringify({ error: "too_many_streams", detail: "too many open build streams, retry shortly" }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
      },
    );
  }

  const adapter = selectAdapter(process.env);

  // The single subscription lifetime controller: client disconnect, stream cancel,
  // and the max-lifetime timer all abort it, and its signal reaches the channel
  // reader so a parked generator returns (never leaks). The timer is unref'd so an
  // idle stream cannot hold the process open.
  const life = new AbortController();
  const abortLife = (): void => life.abort();
  if (request.signal.aborted) life.abort();
  request.signal.addEventListener("abort", abortLife);
  const lifeTimer = setTimeout(abortLife, maxLifetimeMs());
  (lifeTimer as unknown as { unref?: () => void }).unref?.();
  const cleanupLife = (): void => {
    clearTimeout(lifeTimer);
    request.signal.removeEventListener("abort", abortLife);
  };

  // Subscribe BEFORE building the Response: the live adapter runs the channel's
  // capacity admission synchronously here, so saturation is a real pre-stream 503
  // instead of an error frame after a 200 was already sent.
  let source: AsyncIterable<BuildEvent>;
  try {
    source = adapter.subscribeBuildEvents(resourceId, { signal: life.signal });
  } catch (err) {
    cleanupLife();
    releaseStreamSlot();
    if (err instanceof BuildChannelAtCapacityError) {
      return new Response(
        JSON.stringify({ error: "stream_capacity", detail: "too many open build streams, retry shortly" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        },
      );
    }
    throw err;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed (double-close after abort race) - safe to ignore.
        }
      };
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Any lifetime abort closes the stream so the for-await loop below breaks and
      // the async generator stops (Pitfall 4).
      const onAbort = (): void => close();
      life.signal.addEventListener("abort", onAbort);

      try {
        for await (const ev of source) {
          if (life.signal.aborted || closed) break;
          send("stage", ev);
        }
      } finally {
        life.signal.removeEventListener("abort", onAbort);
        cleanupLife();
        close();
        releaseStreamSlot();
      }
    },
    cancel() {
      // The consumer went away without draining: abort the lifetime controller so
      // the channel reader returns and the entry can be evicted, and free the
      // concurrent-stream slot (idempotent with the drain finally above).
      life.abort();
      releaseStreamSlot();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
