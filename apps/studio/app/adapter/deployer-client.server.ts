// deployer-client.server.ts - the server-only SSE client for the increment-A deployer.
//
// This module POSTs a generated bundle to the deployer's authenticated SSE endpoint
// (POST {DEPLOYER_URL}/deploy) and maps the deployer's DeployProgressEvent frames into
// the studio's BuildEvent stream. It is named `.server.ts` so Vite excludes it from the
// client bundle (mirrors live-deps.server.ts): DEPLOYER_AUTH_SECRET and the deployer-call
// code never reach the browser graph.
//
// SECURITY: the bearer goes ONLY in the Authorization header. It is never logged, never
// returned to the browser, and never placed in a BuildEvent.log or a thrown message. The
// non-ok and error paths build their messages from the HTTP status and the deployer's
// {error} field only (request headers are never echoed). ev.message is the deployer's
// plain-prose non-secret stage description, safe to surface as BuildEvent.log.
//
// The studio never imports @utter/deployer: a LOCAL DeployProgressEvent type mirrors the
// increment-A wire contract so the deployer package never enters the studio graph. No new
// external npm dependency is added (global fetch + web ReadableStream + TextDecoder only).
import type { Bundle } from "@utter/ai-runtime";
import type { Pricing } from "@utter/x402-arc";
import type { BuildEvent, BuildStage } from "./types.js";

/**
 * The deployer's progress event, mirrored locally (the studio does not import the
 * deployer package). One frame per `data:` SSE line on the success stream. `result` is
 * the deployer's terminal payload on the final frames; the studio does not read it.
 */
interface DeployProgressEvent {
  phase: "register" | "build" | "launch" | "route" | "verify" | "probe" | "done" | "error";
  status: "running" | "ok" | "error";
  message: string;
  result?: unknown;
}

/** The streamDeploy input: the bundle to deploy plus the trusted slug/label/pricing the
 *  studio controls. resourceLabel is `utter:resource:<slug>` so the deployer-derived
 *  resourceId equals the studio resourceId (the escrow/payTo keystone). The two optionals
 *  are spread into the POST body only when defined. */
export interface DeployBundleParams {
  bundle: Bundle;
  slug: string;
  resourceLabel: string;
  pricing: Pricing;
  maxTimeoutSeconds?: number;
  freePaths?: string[];
  /** The on-chain split recipient (the creator's 70% payee) - the studio's SIWE creator.
   *  Spread into the POST body only when defined; the deployer validates it as an address
   *  and registers it as the resource `creator`, so earnings accrue to the creator, not the
   *  deployer admin key. Money-path SELECTION only; the escrow split math is unchanged. */
  creator?: string;
}

/** Map a deployer phase to a studio BuildStage. register is the on-chain identity step
 *  (Mint); build/launch/route are the deploy steps (Deploy); verify/probe are the
 *  verification steps (Verify). done and error are handled separately by the caller. */
const PHASE_TO_STAGE: Record<string, BuildStage> = {
  register: "Mint",
  build: "Deploy",
  launch: "Deploy",
  route: "Deploy",
  verify: "Verify",
  probe: "Verify",
};

/**
 * Stream a deploy from the increment-A deployer, yielding a BuildEvent per progress
 * frame. POSTs the bundle with Authorization: Bearer to {deployerUrl}/deploy, parses the
 * SSE response, and maps each DeployProgressEvent to a BuildEvent. Returns on the `done`
 * frame; throws (bearer-free) on a non-ok response or an `error` frame.
 */
export async function* streamDeploy(
  params: DeployBundleParams,
  opts: { deployerUrl: string; authSecret: string },
): AsyncGenerator<BuildEvent> {
  const url = `${opts.deployerUrl.replace(/\/+$/, "")}/deploy`;

  // Build the body with the two optionals spread in only when defined.
  const body: Record<string, unknown> = {
    bundle: params.bundle,
    slug: params.slug,
    resourceLabel: params.resourceLabel,
    pricing: params.pricing,
    ...(params.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: params.maxTimeoutSeconds }
      : {}),
    ...(params.freePaths !== undefined ? { freePaths: params.freePaths } : {}),
    // The on-chain split recipient (the 70% payee), sent only when defined. The deployer
    // validates it as an address and registers it as the resource creator.
    ...(params.creator !== undefined ? { creator: params.creator } : {}),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // The bearer goes ONLY here. It is never logged or echoed into any message below.
      headers: {
        authorization: `Bearer ${opts.authSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A NETWORK-level failure (the deployer unreachable) throws TypeError "fetch failed"
    // with the real reason in err.cause.code (ECONNREFUSED / ENOTFOUND / ETIMEDOUT).
    // Surface a BEARER-FREE diagnostic naming the target URL (host:port only - the secret
    // is in the header, never the URL) + the cause code + the actionable fix, so the build
    // stream shows WHY instead of an opaque "fetch failed". The request body/headers are
    // never echoed.
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const codePart = typeof code === "string" ? ` (${code})` : "";
    throw new Error(
      `deployer POST ${url} could not be reached${codePart}: ${(err as Error).message}. ` +
        "Check that the deployer host process is running and listening on that host:port, " +
        "and that DEPLOYER_URL points at host.docker.internal (not localhost) from inside " +
        "the studio container.",
    );
  }

  if (!res.ok) {
    // Read the pre-stream JSON error body and build a bearer-free message from the HTTP
    // status and the deployer's {error} field only. Request headers are never echoed.
    let detail = "";
    try {
      const text = await res.text();
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // A non-JSON body is fine: fall back to naming just the status.
    }
    throw new Error(
      detail
        ? `deployer POST /deploy failed with HTTP ${res.status}: ${detail}`
        : `deployer POST /deploy failed with HTTP ${res.status}`,
    );
  }

  if (!res.body) {
    throw new Error("deployer POST /deploy returned no stream body");
  }

  // Parse the SSE body off the web ReadableStream: decode chunks, split on blank-line
  // frame boundaries, keep the trailing partial in the buffer, and parse each frame's
  // `data:` payload into a DeployProgressEvent. The buffer split tolerates a frame that
  // arrives across two reads.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse one complete frame's `data:` lines into an event, or undefined for a frame
  // with no data line (a comment/keepalive). Yields/returns/throws are driven by the
  // caller loop below, so this only constructs the event.
  const parseFrame = (frame: string): DeployProgressEvent | undefined => {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) return undefined;
    return JSON.parse(dataLines.join("\n")) as DeployProgressEvent;
  };

  // Handle a parsed event: a generator helper would complicate control flow, so the
  // caller loop applies the same logic inline via this small mapper returning a signal.
  const handle = (ev: DeployProgressEvent): { kind: "done" } | { kind: "event"; event: BuildEvent } => {
    if (ev.phase === "done") return { kind: "done" };
    if (ev.phase === "error") throw new Error(ev.message);
    const stage = PHASE_TO_STAGE[ev.phase];
    // An unrecognized phase (neither done/error nor a mapped stage) is skipped, so a
    // future deployer phase cannot crash the studio.
    if (!stage) return { kind: "event", event: undefined as unknown as BuildEvent };
    return { kind: "event", event: { stage, status: ev.status, log: ev.message } };
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    // Drain every complete frame currently in the buffer.
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseFrame(frame);
      if (ev) {
        const signal = handle(ev);
        if (signal.kind === "done") return;
        if (signal.event) yield signal.event;
      }
      sep = buffer.indexOf("\n\n");
    }

    if (done) break;
  }

  // Flush any final buffered frame (a last frame not terminated by a blank line).
  const tail = buffer.trim();
  if (tail.length > 0) {
    const ev = parseFrame(tail);
    if (ev) {
      const signal = handle(ev);
      if (signal.kind === "event" && signal.event) yield signal.event;
      // A trailing done returns implicitly; a trailing error already threw in handle.
    }
  }
}
