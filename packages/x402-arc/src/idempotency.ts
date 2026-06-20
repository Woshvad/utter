// idempotency.ts - the buyer-side idempotent-retrieval helper (PAY-11 client edge).
//
// The idemKey IS the payment `nonce` (bytes32) per SPEC §9.11. A buyer that
// disconnected after the on-chain debit recovers its paid result by idemKey via
// `GET /results/:idemKey` - it NEVER re-signs (re-signing a fresh nonce defeats
// exactly-once and risks a double-charge). `retrieveByIdemKey` returns the stored
// (response, receipt) within the facilitator's TTL, or null on a 404/expiry.
import type { Hex } from "viem";

/** A `fetch`-compatible function (global `fetch` in prod; the in-process app in tests). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The shape `GET /results/:idemKey` returns on a hit (the buyer's paid result). */
export interface RetrievedResult {
  /** The exact response bytes the buyer was owed. */
  response: string;
  /** The settle receipt (tx, payer, amount, idemKey, scheme). */
  receipt: unknown;
}

/** The idemKey IS the payment nonce (bytes32). This is the canonical mapping. */
export function idemKeyForNonce(nonce: Hex): Hex {
  return nonce;
}

/**
 * Retrieve a persisted paid result by its idemKey (the payment nonce) from the
 * facilitator, without re-signing or re-charging. Returns the stored
 * `(response, receipt)` within the result TTL, or `null` if the key is unknown /
 * expired (the `GET /results/:idemKey` 404 path).
 *
 * @param facilitatorUrl The facilitator base URL (no trailing slash).
 * @param idemKey        The payment nonce (bytes32) = the idempotency key.
 * @param fetcher        A `fetch`-like function (default global `fetch`); tests
 *                       pass the in-process facilitator app's request handler.
 */
export async function retrieveByIdemKey(
  facilitatorUrl: string,
  idemKey: Hex,
  fetcher: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<RetrievedResult | null> {
  const url = `${facilitatorUrl.replace(/\/$/, "")}/results/${idemKey}`;
  const res = await fetcher(url, { method: "GET" });
  if (res.status !== 200) return null;
  const body = (await res.json()) as Partial<RetrievedResult> | null;
  if (!body || typeof body.response !== "string") return null;
  return { response: body.response, receipt: body.receipt };
}
