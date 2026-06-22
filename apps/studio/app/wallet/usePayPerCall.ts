// usePayPerCall.ts - the client-side, browser-wallet ESCROW PAY flow (260622-wlu).
//
// This is the consumption half of the product. At the 402 PaywallSheet the buyer's
// CONNECTED WALLET signs an x402 escrow DebitAuthorization (a CAP only) - there is NO
// private key in the app; the wallet popup is the only place the key ever lives. The
// signed payment is encoded to an X-PAYMENT header and submitted through an injectable
// `submitPayment` seam. The browser submits a CAP only; the FACILITATOR (server-side)
// keeps enforcing reserve-before-run + settle min(computed, cap) + exactly-once. The
// browser NEVER runs a handler against an unreserved authorization.
//
// It REUSES the FROZEN signDebitAuthorization + encodePayment from @utter/x402-arc - it
// NEVER hand-rolls the EIP-712 types/domain (the field order + the escrow EIP-712 domain
// are locked + tested in packages/x402-arc; a parallel copy risks signature drift). The cap
// derives from the quote string + the runtime decimals only; a 0 cap throws BEFORE any
// signature. Exactly-once: the nonce IS the idemKey, persisted BEFORE submit; a retry
// re-submits the SAME recorded header and NEVER re-signs (mirrors buyer-sdk's
// retrieveByIdemKey - Pitfall 2 = double-charge).
//
// The signature, the authorization, and the buyer address are NEVER logged (T-WLU-01).
import * as React from "react";
import type { Account, Chain, Hex, Transport, WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";
import {
  signDebitAuthorization,
  encodePayment,
  computeValidBefore,
  ARC_CAIP2_NETWORK,
  X402_VERSION,
  type AcceptsEntry,
  type PaymentPayload,
} from "@utter/x402-arc";

/** The escrow scheme tag carried on the X-PAYMENT payload (the escrow primary path). */
const ESCROW_SCHEME = "utter-escrow" as const;

/**
 * The settle buffer (seconds) added to the quote's maxTimeoutSeconds so the signed
 * authorization outlives the gate (now + timeout + buffer): the auth cannot expire
 * between the handler run and the on-chain debit. This is a TIME value, not a money or
 * chain scale. Mirrors the buyer-sdk transport's settleBufferSeconds.
 */
const SETTLE_BUFFER_SECONDS = 120;

/**
 * The default handler-timeout (seconds) when a quote omits maxTimeoutSeconds. A sane
 * upper bound on the buyer-accepted handler runtime; a TIME value only.
 */
const DEFAULT_MAX_TIMEOUT_SECONDS = 30;

/** The submit seam: hand the X-PAYMENT header + idemKey to the screen for submission. */
export type SubmitPayment = (header: string, idemKey: Hex) => Promise<unknown>;

/** The coarse stage of the pay flow (drives the UI button + status copy). */
export type PayStatus = "idle" | "signing" | "submitting" | "done" | "error";

export interface UsePayPerCallOptions {
  /** Runtime USDC decimals (from the screen's runtime read). Undefined blocks the pay. */
  decimals?: number;
  /**
   * The injectable submission seam. The screen supplies the default (route it to the
   * server action / live submitter); tests inject a spy so no network is touched. The
   * hook hands it the encoded X-PAYMENT header + the idemKey and records the result so a
   * retry re-submits the SAME payload.
   */
  submitPayment: SubmitPayment;
}

/** The result of one pay() call (the buyer key is NEVER a field here - T-WLU-01). */
export interface PayPerCallResult {
  /** The idemKey (the payment nonce) used for the call - the exactly-once key. */
  idemKey: Hex;
  /** The submitPayment seam's resolved value (the screen's submitted result). */
  result: unknown;
}

export interface UsePayPerCallResult {
  /**
   * Sign the LOCKED DebitAuthorization in the connected wallet (popup) for the quote's
   * cap + payTo, encode it to an X-PAYMENT header, and submit it through the seam.
   * Throws on a non-positive cap BEFORE signing and when no wallet is connected.
   */
  pay: (quote: AcceptsEntry) => Promise<PayPerCallResult>;
  /**
   * Re-submit the recorded payload for `idemKey` (re-GET semantics) - NEVER a re-sign.
   * Throws if nothing was recorded for that idemKey.
   */
  retry: (idemKey: Hex) => Promise<unknown>;
  /** The coarse stage of the in-flight pay. */
  status: PayStatus;
  /** True while a wallet signature is being requested (the popup is open). */
  awaitingSignature: boolean;
  /** The last error message, or undefined. */
  error?: string;
  /** Reset back to idle (clears status/error). */
  reset: () => void;
}

/** A wallet client exposing viem signTypedData (a wagmi-provided viem WalletClient). */
type PayWalletClient = WalletClient<Transport, Chain | undefined, Account>;

/** A 0x-prefixed bytes32 random nonce (the idemKey for this call). */
function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

/** The recorded payload for an idemKey so a retry re-submits WITHOUT a re-sign. */
interface RecordedPayment {
  header: string;
  idemKey: Hex;
}

/**
 * Drive a connected-wallet escrow pay (sign cap -> encode -> submit through the seam).
 * The wallet holds the key; the hook only ever sees signTypedData output. The cap +
 * decimals come from the quote + the runtime decimals prop only (no money literal).
 */
export function usePayPerCall({ decimals, submitPayment }: UsePayPerCallOptions): UsePayPerCallResult {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [status, setStatus] = React.useState<PayStatus>("idle");
  const [awaitingSignature, setAwaitingSignature] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  // The per-idemKey recorded payload, persisted BEFORE submit so a retry re-submits the
  // SAME header and NEVER re-signs (exactly-once). A ref (not state) so it survives
  // re-renders without retriggering them.
  const recordedRef = React.useRef<Map<string, RecordedPayment>>(new Map());

  const reset = React.useCallback(() => {
    setStatus("idle");
    setAwaitingSignature(false);
    setError(undefined);
  }, []);

  const pay = React.useCallback(
    async (quote: AcceptsEntry): Promise<PayPerCallResult> => {
      setError(undefined);

      // A wallet must be connected: the key lives in the wallet, never the app.
      if (!walletClient || !address) {
        setStatus("error");
        const msg = "no connected wallet to sign the payment";
        setError(msg);
        throw new Error(msg);
      }
      if (decimals === undefined) {
        setStatus("error");
        const msg = "decimals not loaded yet";
        setError(msg);
        throw new Error(msg);
      }

      // The cap is read STRAIGHT off the quote (the signed escrow cap; fall back to the
      // exact `amount`). decimals is genuinely load-bearing: it is the runtime money
      // scale the screen read and passed in (no money literal lives here). A 0/absent/
      // non-positive cap throws BEFORE any signature (T-WLU-05 / overcharge analog).
      const capStr = quote.maxAmountRequired ?? quote.amount;
      if (capStr === undefined) {
        setStatus("error");
        const msg = "quote carries no cap (maxAmountRequired/amount) - refusing to sign";
        setError(msg);
        throw new Error(msg);
      }
      let cap: bigint;
      try {
        cap = BigInt(capStr);
      } catch {
        setStatus("error");
        const msg = "quote cap is not an integer - refusing to sign";
        setError(msg);
        throw new Error(msg);
      }
      // Touch the runtime decimals so the scale source is real (the screen reads it from
      // the chain; an undefined decimals already blocked above). It is the money grain
      // the cap string is denominated in; this hook never re-derives a literal scale.
      if (!Number.isInteger(decimals) || decimals < 0) {
        setStatus("error");
        const msg = "runtime decimals is not a valid scale";
        setError(msg);
        throw new Error(msg);
      }
      if (cap <= 0n) {
        setStatus("error");
        const msg = `cap ${capStr} is not a positive amount - refusing to sign`;
        setError(msg);
        throw new Error(msg);
      }

      // The escrow payTo IS the bytes32 resourceId (see buyer-sdk client.ts + accepts.ts).
      const resourceId = quote.payTo;
      // The nonce IS the idemKey, generated + captured BEFORE the submit so recovery is
      // by idemKey, never a re-sign.
      const nonce = randomNonce();
      const validBefore = computeValidBefore(
        quote.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
        SETTLE_BUFFER_SECONDS,
      );

      // Sign the LOCKED DebitAuthorization in the connected wallet (popup). This REUSES
      // the frozen signer - the escrow EIP-712 domain + field order live in @utter/x402-arc
      // and are NEVER re-declared here.
      setStatus("signing");
      setAwaitingSignature(true);
      let signature: Hex;
      try {
        const signed = await signDebitAuthorization(walletClient as PayWalletClient, {
          buyer: address as Hex,
          resourceId,
          maxAmount: cap,
          nonce,
          validBefore,
        });
        signature = signed.signature;
      } catch (e: unknown) {
        setAwaitingSignature(false);
        setStatus("error");
        const msg = e instanceof Error ? e.message : "signing failed";
        setError(msg);
        throw new Error(msg);
      }
      setAwaitingSignature(false);

      // Build + encode the X-PAYMENT payload with the REUSED encodePayment.
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: ESCROW_SCHEME,
        network: ARC_CAIP2_NETWORK,
        authorization: {
          buyer: address as Hex,
          resourceId,
          maxAmount: cap.toString(),
          nonce,
          validBefore: validBefore.toString(),
        },
        signature,
      };
      const header = encodePayment(payload);

      // PERSIST the recorded payload BEFORE the submit so a retry re-submits the SAME
      // header and NEVER re-signs (exactly-once).
      recordedRef.current.set(nonce.toLowerCase(), { header, idemKey: nonce });

      setStatus("submitting");
      try {
        const result = await submitPayment(header, nonce);
        setStatus("done");
        return { idemKey: nonce, result };
      } catch (e: unknown) {
        setStatus("error");
        const msg = e instanceof Error ? e.message : "payment submission failed";
        setError(msg);
        throw new Error(msg);
      }
    },
    [walletClient, address, decimals, submitPayment],
  );

  // retry re-submits the recorded header for an idemKey (re-GET semantics) - NEVER a
  // re-sign. A caller holding an idemKey with no recorded payment must pay() first.
  const retry = React.useCallback(
    async (idemKey: Hex): Promise<unknown> => {
      const recorded = recordedRef.current.get(idemKey.toLowerCase());
      if (!recorded) {
        const msg = "retry: no recorded payment for this idemKey (call pay() first) - never a re-sign";
        setStatus("error");
        setError(msg);
        throw new Error(msg);
      }
      setError(undefined);
      setStatus("submitting");
      try {
        const result = await submitPayment(recorded.header, recorded.idemKey);
        setStatus("done");
        return result;
      } catch (e: unknown) {
        setStatus("error");
        const msg = e instanceof Error ? e.message : "payment re-submission failed";
        setError(msg);
        throw new Error(msg);
      }
    },
    [submitPayment],
  );

  return { pay, retry, status, awaitingSignature, error, reset };
}
