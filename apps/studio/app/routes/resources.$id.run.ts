// resources.$id.run.ts - the STU-03 playground Run resource route (260627-fs1).
//
// A React Router v7 framework-mode RESOURCE route (an action only, no default
// component), mirroring resources.$id.events.ts. The browser playground Run does a
// plain fetch POST + res.json(); a DOCUMENT route (one with a default-export
// component) returns the rendered HTML document for such a POST, so res.json() throws
// "Unexpected token '<'". This route returns a REAL JSON Response so the fetch parses.
//
// This is a transport relocation, not a logic change: it carries the SAME run logic
// the resources.$id.tsx action held (including the 260627-emi try/catch error path),
// but lives in a resource route so the client fetch reads real JSON.
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
