// playground-live.server.ts - the playground harness seam.
//
// The DEFAULT harness is the in-process MOCK (runPlaygroundHarness): a real buyer reads
// the served card, the gate reserves the cap BEFORE the handler runs (reserve-before-run)
// and EXACTLY ONE debit <= cap settles, all proven in LOGIC against an in-process
// facilitator + mock chain. That default is correct for a creator "test it", for dev, and
// for demo, where a real on-chain USDC spend would be wrong.
//
// PLAYGROUND_HARNESS=live routes the playground to the REAL buyer pay flow
// (liveTestEndpoint from @utter/marketplace, subtask D1) against the resource's DEPLOYED
// agent card + endpoint. The real on-chain broadcast stays OPERATOR-ARMED: liveTestEndpoint
// throws RequiresFundedWalletError until TEST_BUYER_PRIVATE_KEY and a deployed resource are
// provisioned, so the live branch surfaces the operator-gated error honestly and never
// fakes a success.
//
// This file is `.server.ts` so Vite keeps it out of the client bundle (mirrors the
// live-deps.server.ts convention). The runLive seam is INJECTABLE so the offline test
// never touches real infra; no new external dependency is added.
//
// Money discipline: the 70/30 split is derived from the SETTLED debit (a base-unit
// bigint), mirroring runPlaygroundHarness EXACTLY. The studio authors no money value;
// liveTestEndpoint signs the cap from the card and the deployed facilitator settles
// min(computed, cap). No 1e6/6/18/decimals literal appears in any amount path here.
import { liveTestEndpoint, type TestEndpointResult } from "@utter/marketplace";
import {
  runPlaygroundHarness,
  type PlaygroundHarnessResult,
  CREATOR_BPS,
  BPS_DENOMINATOR,
} from "./playground-harness.js";

/** The resolved playground harness shape (identical in both the mock and live branches). */
export type PlaygroundHarness = (
  resourceId: string,
  req: unknown,
) => Promise<PlaygroundHarnessResult>;

/** The A2A card path suffix the deployed resource serves (EXACTLY this; never agent.json). */
const CARD_PATH = "/.well-known/agent-card.json";

/**
 * Derive the resource's pay URL from its agent-card URL. Strip a trailing agent-card path
 * (if present) to get the resource base, then append `/call` - the Utter-generated handler
 * pay path the inject-x402 gate wraps (see test-endpoint.ts requirePayment on `/call`).
 */
export function deriveEndpointUrl(cardUrl: string): string {
  const base = cardUrl.endsWith(CARD_PATH) ? cardUrl.slice(0, -CARD_PATH.length) : cardUrl;
  // Strip a trailing slash on the base before appending /call so we never produce //call.
  return `${base.replace(/\/+$/, "")}/call`;
}

/**
 * Project a live TestEndpointResult into the studio PlaygroundHarnessResult, mirroring
 * runPlaygroundHarness's projection EXACTLY: the 70/30 split is derived from the SETTLED
 * debit (a base-unit bigint - the on-chain PaymentSplitter enforces the same split). The
 * live run has no relayer here (the deployed facilitator owns it), so debits is 1 iff the
 * paid call succeeded; the runtime decimals() read is the precision witness (count 1).
 */
export function mapLiveResult(result: TestEndpointResult): PlaygroundHarnessResult {
  const settled = result.debitAmount;
  const creatorShare = (settled * CREATOR_BPS) / BPS_DENOMINATOR;
  const treasuryShare = settled - creatorShare;
  const debits = result.paid ? 1 : 0;
  const decimalsReads = 1;
  return { result, debits, decimalsReads, creatorShare, treasuryShare };
}

/**
 * Resolve the playground harness from env. With PLAYGROUND_HARNESS unset (or not "live")
 * this returns runPlaygroundHarness VERBATIM (the frozen mock; the dev/demo default), so
 * the default behavior is byte-unchanged. With PLAYGROUND_HARNESS=live it returns an async
 * closure that resolves the resource's deployed card URL, derives the /call endpoint, and
 * runs the REAL buyer pay flow (liveTestEndpoint), surfacing RequiresFundedWalletError
 * honestly when the operator key is absent.
 *
 * deps.getCardUrl resolves a resourceId to its deployed agent-card URL (or null if the
 * resource is unknown / not discoverable). deps.runLive is the injectable live runner seam;
 * it defaults to liveTestEndpoint and is overridden only by the offline test.
 */
export function resolvePlaygroundHarness(
  env: NodeJS.ProcessEnv,
  deps: {
    getCardUrl: (resourceId: string) => Promise<string | null>;
    runLive?: typeof liveTestEndpoint;
  },
): PlaygroundHarness {
  if (env.PLAYGROUND_HARNESS !== "live") {
    // The frozen in-process mock: the dev/demo/"test it" default. Reserve-before-run +
    // exactly-once are proven in LOGIC by runPlaygroundHarness; returned verbatim.
    return runPlaygroundHarness;
  }

  return async (resourceId: string, req: unknown): Promise<PlaygroundHarnessResult> => {
    const cardUrl = await deps.getCardUrl(resourceId);
    if (!cardUrl) {
      throw new Error(
        `live playground: resource ${resourceId} has no card URL (not discoverable)`,
      );
    }
    const endpointUrl = deriveEndpointUrl(cardUrl);
    const runLive = deps.runLive ?? liveTestEndpoint;
    // liveTestEndpoint throws RequiresFundedWalletError when armed-without-keys; that
    // surfaces to the caller honestly - the studio shows the operator-gated error, never
    // a fake success.
    const result = await runLive({ cardUrl, endpointUrl, requestBody: req, env });
    return mapLiveResult(result);
  };
}
