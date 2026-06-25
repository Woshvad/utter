// submit-payment.ts - the client-side X-PAYMENT submission seam (260622-wlu, 260623-deq).
//
// usePayPerCall signs the escrow CAP authorization in the connected wallet and hands the
// encoded X-PAYMENT header to a `submitPayment(header, idemKey)` seam. This module
// supplies that seam for the studio screen, mirroring the established selectAdapter /
// RequiresLive* boundary EXACTLY:
//
//   - The FIXTURE/default submitter routes the signed cap BACK through the existing
//     resources.$id server action (the in-process facilitator that action already drives:
//     reserve-before-run + the validation gate + settle min(computed, cap) + exactly-once
//     stay SERVER-SIDE). The browser submits a cap only; it never runs a handler against
//     an unreserved authorization. The autonomous suite stays deterministic.
//
//   - The LIVE submitter is the REAL client-side x402 transport (260623-deq). It POSTs the
//     signed X-PAYMENT header to the DEPLOYED RESOURCE endpoint; the resource's gate calls
//     the facilitator server-side (reserve -> run -> validate -> settle). The browser only
//     submits a signed cap; it NEVER runs a handler against an unreserved authorization.
//     It is still operator-gated: when no live endpoint is configured the selector returns
//     a FAIL-LOUD submitter (RequiresLivePaymentError). The transport never fakes a call.
//
// The exactly-once contract is upheld by usePayPerCall (nonce = idemKey, persisted before
// submit; a retry re-submits the SAME header, never a re-sign). This seam is a thin
// transport: it forwards the header + idemKey and never re-signs or mutates them. The
// idemKey rides INSIDE the X-PAYMENT payload (authorization.nonce), so the live wire never
// sends an X-IDEM-KEY header - that is a studio fixture-only convention.
//
// The X-PAYMENT header, the signature, the settlement receipt, and the buyer address are
// NEVER logged (T-WLU-01).
import type { Hex } from "viem";
import type { PlaygroundResult } from "../adapter/types.js";

/** The submit seam usePayPerCall calls: hand off the X-PAYMENT header + the idemKey. */
export type SubmitPayment = (header: string, idemKey: Hex) => Promise<PlaygroundResult>;

/** The default run route on a deployed resource (the buyer-sdk / marketplace canonical). */
const DEFAULT_RUN_PATH = "/call";

/**
 * The error thrown when the LIVE X-PAYMENT submission is invoked but the operator has not
 * configured a live endpoint. The transport now EXISTS (260623-deq); the remaining gap is
 * a configured live resource endpoint plus the on-host infra documented in the runbook
 * (apps/studio/docs/LIVE-PAY-RUNBOOK.md). It NEVER returns fake data and NEVER fakes a
 * network call - matching RequiresLiveServicesError (adapter/live.ts) and the buyer-sdk
 * live gate.
 */
export class RequiresLivePaymentError extends Error {
  readonly code = "requiresLivePayment" as const;
  constructor() {
    super(
      "Live X-PAYMENT submission is operator-gated: the client transport now exists, but " +
        "no live resource endpoint is configured. Provision STUDIO_DATA_ADAPTER=live with " +
        "real resource cardUrls (so a real resource origin is derived), a reachable " +
        "facilitator with a funded relayer, the resource deployed behind the wildcard-TLS " +
        "resources host, and a funded buyer escrow - see apps/studio/docs/LIVE-PAY-RUNBOOK.md. " +
        "It is fail-loud and NEVER fakes a network call.",
    );
    this.name = "RequiresLivePaymentError";
  }
}

/**
 * Decode the X-PAYMENT-RESPONSE settlement receipt in the BROWSER (no Node Buffer): the
 * header is base64(JSON). atob -> bytes -> TextDecoder. Returns the parsed receipt or
 * undefined on any decode/parse failure (an absent/garbled receipt is not a failure of the
 * paid call - the 200 is authoritative; we just have no settled amount to read).
 */
function decodePaymentReceipt(headerValue: string): { amount?: string; tx?: string } | undefined {
  try {
    const bytes = Uint8Array.from(atob(headerValue), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as { amount?: string; tx?: string };
  } catch {
    return undefined;
  }
}

/**
 * The fixture/default submitter: route the signed X-PAYMENT header BACK through the
 * existing resources.$id server action (the in-process facilitator). The header is carried
 * in an `X-PAYMENT` request header (the wire convention) so the server side can pick the
 * paying beat; the action still drives reserve-before-run + the gate server-side. The
 * bigint debitAmount is re-read from the string the action serializes.
 */
export function fixtureSubmitPayment(resourceId: string): SubmitPayment {
  return async (header: string, idemKey: Hex): Promise<PlaygroundResult> => {
    const res = await fetch(`/resources/${resourceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The X-PAYMENT header carries the signed cap; X-IDEM-KEY makes the exactly-once
        // key explicit for the server result store. Neither is logged here.
        "X-PAYMENT": header,
        "X-IDEM-KEY": idemKey,
      },
      // The action reads the request body for the run; the paying beat is signaled by the
      // X-PAYMENT header. Send the prior benign body so the handler has input.
      body: JSON.stringify({ pay: true }),
    });
    const data = (await res.json()) as Omit<PlaygroundResult, "debitAmount"> & {
      debitAmount: string;
    };
    return { ...data, debitAmount: BigInt(data.debitAmount) };
  };
}

/**
 * The LIVE submitter: the REAL client-side x402 transport (260623-deq). POST the signed
 * X-PAYMENT header to the DEPLOYED RESOURCE endpoint (NOT the facilitator - the resource's
 * gate calls the facilitator server-side). The body is the SAME real handler request body
 * that triggered the 402 (read at call time via getRequestBody). On HTTP 200 the call is
 * paid; the settlement receipt rides the X-PAYMENT-RESPONSE response header (browser-decoded
 * base64 JSON), and the settled base-unit DECIMAL STRING `amount` becomes the bigint debit.
 * Any non-200 means NOT paid and rejects. No X-IDEM-KEY is sent (the idemKey rides inside
 * the X-PAYMENT payload). The header, receipt, body, and address are NEVER logged.
 */
export function liveSubmitPayment(opts: {
  resourceUrl: string;
  getRequestBody: () => unknown;
  path?: string;
}): SubmitPayment {
  // idemKey is intentionally unused on the wire - it rides inside the X-PAYMENT payload
  // (authorization.nonce). The seam signature is kept; we never add an X-IDEM-KEY header.
  return async (header: string, _idemKey: Hex): Promise<PlaygroundResult> => {
    const url = `${opts.resourceUrl}${opts.path ?? DEFAULT_RUN_PATH}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": header,
      },
      body: JSON.stringify(opts.getRequestBody() ?? null),
    });
    if (res.status !== 200) {
      // No body or secret in the message; the status is the only fact surfaced. Any non-200
      // (402 verify-fail, 502 settlement/validation, 504 timeout) means the call was NOT
      // paid; rejecting keeps the paywall up for a retry (the SAME header, never a re-sign).
      throw new Error(`live pay: resource returned ${res.status}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    // The settled debit comes ONLY from the receipt's decimal string (no money literal).
    let debitAmount = 0n;
    const receiptHeader = res.headers.get("X-PAYMENT-RESPONSE");
    if (receiptHeader) {
      const receipt = decodePaymentReceipt(receiptHeader);
      if (receipt?.amount !== undefined) debitAmount = BigInt(receipt.amount);
    }
    return {
      paid: true,
      debitAmount,
      body,
      bodyBytes: new TextEncoder().encode(text).length,
    };
  };
}

/** The fail-loud submitter for live mode with no configured endpoint. Never fakes a call. */
function requiresLiveSubmitPayment(): SubmitPayment {
  return async (): Promise<PlaygroundResult> => {
    throw new RequiresLivePaymentError();
  };
}

/**
 * Select the submit seam, mirroring selectAdapter's absent-env-to-fixture invariant.
 * The autonomous/browser default is the fixture submitter (routes through the existing
 * action). `mode === "live"` selects the REAL transport when a live endpoint is configured
 * (a non-empty resourceUrl AND a getRequestBody), otherwise the fail-loud live submitter
 * (the operator has not wired an endpoint). Anything else keeps the deterministic fixture
 * path. `mode` is read from the injected flag (the screen passes the server-derived value).
 *
 * No transport change is needed for the studio-initiated live pay (260625-4q5): the path
 * already defaults to /call (DEFAULT_RUN_PATH) and the resource serves /call behind its
 * gate. The remaining piece is upstream: once the detail cardUrl is a REAL DEPLOY_DOMAIN
 * URL (live-deps.server resolveCardUrl), resourceUrlFromCard(detail.cardUrl) yields a real
 * resource origin, so this selector picks liveSubmitPayment (the real client-side x402
 * transport) instead of the fail-loud requiresLiveSubmitPayment stub. The example.com dev
 * fallback still yields a non-empty origin, so the selector is governed by mode === "live"
 * being set by the operator, not by the cardUrl being real.
 */
export function selectSubmitPayment(opts: {
  resourceId: string;
  mode?: string | undefined;
  resourceUrl?: string | undefined;
  getRequestBody?: (() => unknown) | undefined;
}): SubmitPayment {
  if (opts.mode === "live") {
    if (opts.resourceUrl && opts.resourceUrl.length > 0 && opts.getRequestBody) {
      return liveSubmitPayment({
        resourceUrl: opts.resourceUrl,
        getRequestBody: opts.getRequestBody,
      });
    }
    return requiresLiveSubmitPayment();
  }
  return fixtureSubmitPayment(opts.resourceId);
}
