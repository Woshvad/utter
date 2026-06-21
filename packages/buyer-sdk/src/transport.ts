// transport.ts - the injectable buyer transport seam (BUY-01).
//
// Mirrors apps/studio/app/adapter/select.ts (selectAdapter) EXACTLY: a readonly env
// discriminator returns the deterministic FIXTURE transport by default (the in-process
// facilitator createApp + a mock chain + a debit-counting relayer), and the LIVE
// transport only when env.BUYER_SDK_TRANSPORT === "live". The live path is fail-loud
// (RequiresLiveBuyerError) - the autonomous suite reaches NO network/chain/HTTPS path
// unless the operator explicitly opts in. This is the same operator-gating shape as
// RequiresFundedWalletError (apps/marketplace/src/test-endpoint.ts) and selectGenerator/
// selectProber/selectAdapter across the repo.
//
// `viem` is imported TYPE-ONLY here (erased at build): the package keeps no runtime
// viem coupling; the injected chain client only has to satisfy the PublicClient shape.
import type { PublicClient } from "viem";
import { PAYMENT_SPLITTER } from "@utter/chain";
import type { FetchLike } from "@utter/x402-arc";
import { createApp } from "@utter/facilitator/app";
import { createInMemoryStores } from "@utter/facilitator/stores/memory";
import { createInMemoryBuyerLock } from "@utter/facilitator/verify";
import type { RelayerPool } from "@utter/facilitator/relayer";

/**
 * The default escrow timing window the client signs `validBefore` over (mirrors
 * runTestEndpoint / the echo example). Gate timing knobs, not money - no decimals
 * literal here.
 */
export const MAX_TIMEOUT_SECONDS = 30;
export const SETTLE_BUFFER_SECONDS = 90;
/** The in-process facilitator base URL the fixture routes through (no real host). */
export const FIXTURE_FACILITATOR_URL = "http://buyer-sdk.local";

/**
 * The seam the client pays through. The client never talks to a real host/chain
 * directly: it discovers + pays through `fetcher` (routing to the facilitator) and
 * mounts the resource gate on top of `mountFacilitator` (which wires the in-process
 * facilitator with the card-derived escrow/asset addresses). `publicClient` is the
 * chain reader (decimals/balanceOf); `relayerPool` is the settle signer. The fixture
 * injects a mock chain + a debit-counting relayer; the live path supplies the real
 * Arc client + the standalone facilitator (operator-gated).
 */
export interface BuyerTransport {
  /** A label for diagnostics (never logged to stdout). */
  readonly kind: "fixture" | "live";
  /** The chain read client (decimals + escrow balanceOf + receipts). */
  readonly publicClient: PublicClient;
  /** The relayer pool the in-process facilitator settles through. */
  readonly relayerPool: RelayerPool;
  /** The facilitator base URL the client's retrieveByIdemKey GETs against. */
  readonly facilitatorUrl: string;
  /** Default escrow timing knobs (signed into validBefore). */
  readonly maxTimeoutSeconds: number;
  readonly settleBufferSeconds: number;
  /**
   * Mount an in-process facilitator bound to the card-derived escrow/asset/usdc
   * addresses and return a `fetcher` routing to it. The client builds the resource
   * gate against this fetcher (exactly as runTestEndpoint lines 247-261).
   */
  mountFacilitator(opts: { escrow: `0x${string}`; asset: `0x${string}` }): {
    fetcher: FetchLike;
  };
}

/** A 0-arg factory the fixture transport uses to build its mock chain + relayer. */
export interface FixtureTransportDeps {
  /** The mock chain reader (decimals/balanceOf/receipts). */
  publicClient: PublicClient;
  /** The mock debit-counting relayer pool. */
  relayerPool: RelayerPool;
}

/**
 * The operator-gated fail-loud error for the live buyer transport. Mirrors
 * RequiresFundedWalletError (apps/marketplace/src/test-endpoint.ts lines 385-395):
 * a readonly `code` discriminant + a message naming the missing `.env.local` keys.
 * The live transport is NEVER run by the autonomous suite.
 */
export class RequiresLiveBuyerError extends Error {
  readonly code = "requiresLiveBuyer" as const;
  constructor() {
    super(
      "The live buyer transport requires BUYER_PRIVATE_KEY + a deployed resource " +
        "over HTTPS (FACILITATOR_URL) in .env.local. The live pay flow broadcasts " +
        "irreversible on-chain debits; it is operator-gated and not run autonomously.",
    );
    this.name = "RequiresLiveBuyerError";
  }
}

/**
 * Build the FIXTURE transport: an in-process facilitator (createApp +
 * createInMemoryStores + createInMemoryBuyerLock) bound per-mount to the card-derived
 * escrow/asset, plus the injected mock chain + debit-counting relayer. The `fetcher`
 * routes to `facilitator.request` exactly as runTestEndpoint lines 247-261. This is the
 * deterministic autonomous-test default - it reaches no real network or chain.
 */
export function createFixtureTransport(deps: FixtureTransportDeps): BuyerTransport {
  return {
    kind: "fixture",
    publicClient: deps.publicClient,
    relayerPool: deps.relayerPool,
    facilitatorUrl: FIXTURE_FACILITATOR_URL,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    settleBufferSeconds: SETTLE_BUFFER_SECONDS,
    mountFacilitator({ escrow, asset }) {
      const stores = createInMemoryStores();
      const facilitator = createApp({
        store: stores.payments,
        resultStore: stores.results,
        relayerPool: deps.relayerPool,
        publicClient: deps.publicClient as never,
        perBuyerLock: createInMemoryBuyerLock(),
        escrowAddress: escrow,
        splitterAddress: PAYMENT_SPLITTER,
        usdcAddress: asset,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        settleBufferSeconds: SETTLE_BUFFER_SECONDS,
      });
      const fetcher: FetchLike = async (input, init) =>
        facilitator.request(input, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        });
      return { fetcher };
    },
  };
}

/**
 * Build the LIVE transport. This path targets a deployed resource over HTTPS and the
 * standalone facilitator on Arc with a funded buyer EOA - it broadcasts irreversible
 * on-chain debits. It is OPERATOR-GATED and fail-loud: invoking it without the
 * provisioned `.env.local` keys (or at all, in the autonomous build) throws
 * RequiresLiveBuyerError so the autonomous suite can never mistake it for a live run.
 */
export function createLiveTransport(_env: NodeJS.ProcessEnv = process.env): BuyerTransport {
  throw new RequiresLiveBuyerError();
}

/**
 * Select the buyer transport by env. Returns the deterministic fixture transport by
 * default (when BUYER_SDK_TRANSPORT is unset or anything other than "live"); the live
 * transport (fail-loud) only when it is explicitly "live". The absent-env-to-fixture
 * branch is what keeps the autonomous suite safe (selectAdapter idiom).
 *
 * The fixture deps (the mock chain + relayer) are injected by the test harness; in a
 * default `process.env` run with no injected deps the fixture cannot be built (there is
 * no mock chain), so the caller must pass `fixtureDeps`. Production wiring always goes
 * through the live path (operator-gated).
 */
export function selectBuyerTransport(
  env: NodeJS.ProcessEnv = process.env,
  fixtureDeps?: FixtureTransportDeps,
): BuyerTransport {
  if (env.BUYER_SDK_TRANSPORT === "live") {
    return createLiveTransport(env);
  }
  if (!fixtureDeps) {
    throw new Error(
      "selectBuyerTransport: the fixture transport requires injected chain deps " +
        "(publicClient + relayerPool). Set BUYER_SDK_TRANSPORT=live for the " +
        "operator-gated live transport.",
    );
  }
  return createFixtureTransport(fixtureDeps);
}
