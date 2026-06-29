// Arc Testnet wallet-client factory (PAY-10 settle path).
// Mirrors `createArcPublicClient` (arc.ts) exactly - same trimmed-RPC override and
// default-RPC fallback - swapping the public client for a wallet client and binding
// a Viem account. This is the single write-path attach point for the facilitator's
// relayer signer pool: the account is wrapped with its own `createNonceManager`
// BEFORE being handed in (Pattern 6), so this factory itself stays
// nonce-manager-agnostic and never owns key material. Keys live only in
// `.env.local` (gitignored); this module never logs the account.
import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type HttpTransport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "./arc";

/**
 * Build a Viem wallet client bound to Arc Testnet for a relayer account.
 *
 * The RPC URL is overridable (same `ARC_RPC_URL` override + chain-default fallback
 * as `createArcPublicClient`) so a rate-limited public endpoint can be swapped for
 * an alternate provider. The `account` is a Viem `Account` (typically a
 * `privateKeyToAccount` local account already wrapped with a per-signer nonce
 * manager); this factory does not create or persist keys.
 */
export function createArcWalletClient(
  account: Account,
  rpcUrl?: string,
): WalletClient<HttpTransport, Chain, Account> {
  // Only honor an override that is actually a non-empty string. A blank or
  // whitespace-only ARC_RPC_URL falls back to the chain default rather than
  // silently building a client that fails opaquely at first send.
  const trimmed = rpcUrl?.trim();
  const url = trimmed && trimmed.length > 0 ? trimmed : arcTestnet.rpcUrls.default.http[0];
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(url),
  });
}

/**
 * Build a buyer/signer wallet from a raw private key the CALLER read from
 * `.env.local`. The key is never logged here. This keeps `privateKeyToAccount`
 * (viem) encapsulated in @utter/chain so consumers (the marketplace) need no
 * direct runtime viem import to construct a buyer wallet from a key.
 *
 * A buyer wallet only SIGNS typed data (the DebitAuthorization); it never
 * broadcasts a settle, so no nonce manager is attached to the account. The RPC
 * URL has the same override + chain-default fallback as `createArcWalletClient`.
 */
export function createArcWalletClientFromKey(
  privateKey: Hex,
  rpcUrl?: string,
): WalletClient<HttpTransport, Chain, Account> {
  return createArcWalletClient(privateKeyToAccount(privateKey), rpcUrl);
}
