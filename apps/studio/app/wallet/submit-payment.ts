// submit-payment.ts - the client-side X-PAYMENT submission seam (260622-wlu).
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
//   - The LIVE submitter is operator-gated and FAIL-LOUD: it throws RequiresLivePaymentError
//     naming what the operator must provision (a real facilitator URL + a deployed resource
//     + a funded escrow). It NEVER fakes a network call. The on-chain settle itself is
//     already proven (DEPLOYMENTS.md, 2026-06-20) and is out of scope here.
//
// The exactly-once contract is upheld by usePayPerCall (nonce = idemKey, persisted before
// submit; a retry re-submits the SAME header, never a re-sign). This seam is a thin
// transport: it forwards the header + idemKey and never re-signs or mutates them.
import type { Hex } from "viem";
import type { PlaygroundResult } from "../adapter/types.js";

/** The submit seam usePayPerCall calls: hand off the X-PAYMENT header + the idemKey. */
export type SubmitPayment = (header: string, idemKey: Hex) => Promise<PlaygroundResult>;

/**
 * The error thrown when the LIVE X-PAYMENT submission is invoked but the operator has not
 * provisioned the live half. It names the next provisioning step and NEVER returns fake
 * data - matching RequiresLiveServicesError (adapter/live.ts) and the buyer-sdk live gate.
 */
export class RequiresLivePaymentError extends Error {
  readonly code = "requiresLivePayment" as const;
  constructor() {
    super(
      "Live X-PAYMENT submission is not wired yet: it is operator-gated and requires a " +
        "provisioned facilitator URL, a deployed resource endpoint, and a funded escrow " +
        "balance (stage TEST_BUYER_PRIVATE_KEY-funded escrow + the live facilitator in " +
        ".env.local). It is fail-loud and NEVER fakes a network call. The on-chain settle " +
        "is already proven (DEPLOYMENTS.md); only the live submission transport is gated.",
    );
    this.name = "RequiresLivePaymentError";
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

/** The live submitter: fail-loud, operator-gated. NEVER fakes a network call. */
export function liveSubmitPayment(): SubmitPayment {
  return async (): Promise<PlaygroundResult> => {
    throw new RequiresLivePaymentError();
  };
}

/**
 * Select the submit seam, mirroring selectAdapter's absent-env-to-fixture invariant.
 * The autonomous/browser default is the fixture submitter (routes through the existing
 * action); only an explicit `live` flag selects the fail-loud live submitter. `live` is
 * read from the injected flag (the screen passes the build-time value); absent or any
 * other value keeps the deterministic fixture path.
 */
export function selectSubmitPayment(opts: {
  resourceId: string;
  mode?: string | undefined;
}): SubmitPayment {
  if (opts.mode === "live") return liveSubmitPayment();
  return fixtureSubmitPayment(opts.resourceId);
}
