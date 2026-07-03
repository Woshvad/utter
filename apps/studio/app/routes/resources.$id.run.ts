// resources.$id.run.ts - the STU-03 playground Run resource route (260627-fs1 + S6).
//
// A React Router v7 framework-mode RESOURCE route (an action only, no default
// component), mirroring resources.$id.events.ts. The browser playground Run does a
// plain fetch POST + res.json(); a DOCUMENT route (one with a default-export
// component) returns the rendered HTML document for such a POST, so res.json() throws
// "Unexpected token '<'". This route returns a REAL JSON Response so the fetch parses.
//
// S6 admission:
//   - ALWAYS rate-limited by client IP (RUN_LIMIT_PER_IP_PER_MIN, default 30/min).
//     When a session is present, a per-creator bucket (same limit) is ALSO checked.
//     IP is the PRIMARY key because wallets are free (SIWE signs any local key), so
//     keying by "creator if present else IP" would let one source mint unlimited
//     fresh buckets; both applicable buckets are peeked first and committed only
//     when every one allowed.
//   - the 429 deny body is PlaygroundResult-shaped (the client does
//     BigInt(data.debitAmount) unconditionally and reads the same field set the
//     success and error paths serialize), status 429 + Retry-After.
//   - when PLAYGROUND_HARNESS=live, the run debits the operator's test-buyer wallet
//     on-chain, so requireResourceOwner gates the run: only the resource owner may
//     test their endpoint. The default mock harness stays public.
//
// T-06-FREECOMPUTE: reserve-before-run stays INSIDE adapter.runPlayground - the
// component never calls a handler against an unreserved authorization; the only run
// path is through this adapter seam. The bigint debit is serialized to a wire string.
//
// T-06-PARAM: params.id is validated (isSafeParam, the events-route idiom) before it
// reaches the adapter, so a crafted param cannot reach the source.
import type { ActionFunctionArgs } from "react-router";
import { selectAdapter } from "../adapter/select.js";
import type { PlaygroundResult } from "../adapter/types.js";
import { getAuthAddress } from "../auth/session.server.js";
import { requireResourceOwner } from "../auth/requireCreator.server.js";
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

/** The shared run limiter (module singleton, lazy so env is read at first use). One
 *  limiter instance holds both key families ("ip:..." and "creator:..."), each with
 *  the same limit and window. */
let runLimiter: FixedWindowLimiter | undefined;
/** A separate GLOBAL backstop window (higher limit) so an attacker rotating source
 *  addresses to mint fresh per-IP buckets (a routed IPv6 /56-/48 yields many /64
 *  keys) still cannot amplify runs past a platform-wide ceiling. */
let runGlobalLimiter: FixedWindowLimiter | undefined;

function limiter(): FixedWindowLimiter {
  if (!runLimiter) {
    runLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(process.env.RUN_LIMIT_PER_IP_PER_MIN, 30, "RUN_LIMIT_PER_IP_PER_MIN"),
      windowMs: 60_000,
    });
  }
  return runLimiter;
}

function globalLimiter(): FixedWindowLimiter {
  if (!runGlobalLimiter) {
    runGlobalLimiter = new FixedWindowLimiter({
      limit: parsePositiveInt(process.env.RUN_LIMIT_GLOBAL_PER_MIN, 300, "RUN_LIMIT_GLOBAL_PER_MIN"),
      windowMs: 60_000,
    });
  }
  return runGlobalLimiter;
}

/**
 * Build a PlaygroundResult-shaped deny Response. The body MUST carry the exact field
 * set the client parses (paid/debitAmount/body/bodyBytes/handlerMs/paywall), because
 * resources.$id.tsx onRun does res.json() + BigInt(data.debitAmount) unconditionally
 * and never checks res.ok - ANY other shape (a bare {error} body from a thrown auth
 * Response, say) crashes the playground with BigInt(undefined). Retry-After is set
 * only when a retry window is known.
 */
function playgroundDeny(status: number, body: unknown, retryAfterMs?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfterMs !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
  return new Response(
    JSON.stringify({
      paid: false,
      debitAmount: "0",
      body,
      bodyBytes: 0,
      handlerMs: 0,
      paywall: null,
    }),
    { status, headers },
  );
}

/** The 429 rate-limit deny (PlaygroundResult-shaped). */
function rateLimited(retryAfterMs: number): Response {
  return playgroundDeny(429, { error: "rate_limited", retryAfterMs }, retryAfterMs);
}

/**
 * Run the playground 402 pay-flow for a resource and return a real JSON Response. On a
 * successful adapter.runPlayground the body carries the run result with debitAmount
 * serialized as a string; on a rejected hosted run (a live container failure) the body
 * is an error-shaped 200 the client can render, never a non-Response throw that becomes
 * an unparseable 500. The escrow gate is untouched - reserve-before-run lives inside
 * adapter.runPlayground (T-06-FREECOMPUTE).
 */
export async function action({ params, request }: ActionFunctionArgs): Promise<Response> {
  if (!isSafeParam(params.id)) {
    // Bad param: return (do not throw) a 400 Response, exactly as the events route does.
    return new Response(JSON.stringify({ error: "bad_resource" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Admission: peek EVERY applicable bucket first, commit ALL only when every one
  // allowed (a denied request inserts nothing). The IP bucket always applies; the
  // creator bucket applies only when a session is present; the global backstop always
  // applies.
  const l = limiter();
  const g = globalLimiter();
  const keys = [`ip:${clientIpKey(request)}`];
  const sessionCreator = await getAuthAddress(request);
  if (sessionCreator) keys.push(`creator:${sessionCreator.toLowerCase()}`);
  for (const key of keys) {
    const verdict = l.peek(key);
    if (!verdict.allowed) return rateLimited(verdict.retryAfterMs);
  }
  const globalVerdict = g.peek("global");
  if (!globalVerdict.allowed) return rateLimited(globalVerdict.retryAfterMs);
  for (const key of keys) l.commit(key);
  g.commit("global");

  // Live harness: the run debits the operator's test-buyer wallet on-chain, so only
  // the resource owner may run it. requireResourceOwner throws a Response (401/403/
  // 404) whose body is NOT PlaygroundResult-shaped, so surfacing it raw would crash
  // the client on BigInt(undefined). Convert it to a shaped deny carrying a clear
  // reason. The default mock harness stays public.
  if (process.env.PLAYGROUND_HARNESS === "live") {
    try {
      await requireResourceOwner(request, params.id);
    } catch (thrown) {
      if (thrown instanceof Response) {
        const status = thrown.status >= 400 && thrown.status < 500 ? thrown.status : 403;
        const message =
          status === 401
            ? "sign in with your creator wallet to test this endpoint (live runs debit on-chain)"
            : status === 404
              ? "resource not found"
              : "only the resource owner can run this endpoint in live mode";
        return playgroundDeny(status, { error: message });
      }
      throw thrown;
    }
  }

  let req: unknown = null;
  try {
    const text = await request.text();
    req = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    req = null;
  }
  const adapter = selectAdapter(process.env);
  try {
    const result: PlaygroundResult = await adapter.runPlayground(params.id, req);
    // Serialize the bigint debit for the wire; the client re-reads it as a string.
    return new Response(
      JSON.stringify({
        paid: result.paid,
        debitAmount: result.debitAmount.toString(),
        body: result.body,
        bodyBytes: result.bodyBytes,
        handlerMs: result.handlerMs,
        paywall: result.paywall,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Error path: a rejected hosted run (a live deployer/sandbox failure) returns an
    // error-shaped 200 JSON the client can render, rather than a non-Response throw that
    // becomes a 500 the client fetch cannot parse and that hangs the response pane. The
    // debitAmount is the wire string "0" (this route serializes the debit as a string).
    // console.error logs the failure server-side only; a playground run error carries no
    // secret. The escrow gate is untouched: this is purely the rejection branch.
    console.error("playground run failed", err);
    return new Response(
      JSON.stringify({
        paid: false,
        debitAmount: "0",
        body: { error: err instanceof Error ? err.message : "playground run failed" },
        bodyBytes: 0,
        handlerMs: 0,
        paywall: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
}
