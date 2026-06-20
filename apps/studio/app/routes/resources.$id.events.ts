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
// T-06-SSE-LEAK: request.signal's abort listener breaks the for-await loop and
// closes the controller, so a client disconnect terminates the underlying async
// generator (Pitfall 4 - never leak the generator). The test drains to completion
// AND aborts explicitly, asserting clean termination (no hang).
//
// T-06-PARAM: params.id is validated (isSafeParam, the card-route.ts idiom) before
// it reaches the adapter, so a crafted param cannot reach the source.
import type { LoaderFunctionArgs } from "react-router";
import { selectAdapter } from "../adapter/select.js";

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
 * Stream the build pipeline for a resource as Server-Sent Events. Each BuildEvent
 * is emitted as an `event: stage` frame with the JSON event as `data`. The stream
 * closes when the source generator completes OR the client aborts (request.signal).
 */
export async function loader({ params, request }: LoaderFunctionArgs): Promise<Response> {
  if (!isSafeParam(params.id)) {
    return new Response(JSON.stringify({ error: "bad_resource" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const resourceId = params.id;
  const adapter = selectAdapter(process.env);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed (double-close after abort race) - safe to ignore.
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // T-06-SSE-LEAK: wire the client-disconnect abort to close the stream so the
      // for-await loop below breaks and the async generator stops (Pitfall 4).
      const onAbort = () => close();
      request.signal.addEventListener("abort", onAbort);

      try {
        for await (const ev of adapter.subscribeBuildEvents(resourceId)) {
          if (request.signal.aborted || closed) break;
          send("stage", ev);
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        close();
      }
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
