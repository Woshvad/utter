// Relayer signer pool + per-signer nonce manager (PAY-10).
//
// `/settle` calls the escrow `debit` as `onlyAdmin`. Under concurrency, multiple
// settles from ONE EOA must get strictly sequential EVM tx nonces or the chain
// rejects them (nonce collision). Each relayer key here is a Viem local account
// wrapped with its OWN `createNonceManager` (Pattern 6): the manager tracks the
// pending nonce in-process - sourced from `eth_getTransactionCount(addr,'pending')`
// - and auto-increments for concurrent sends, so N concurrent `consume()` calls on
// one signer return 0,1,2,... with no duplicate.
//
// The pool picks a free / least-busy signer per settle (round-robin) to spread
// load across keys. On a reorg or dropped tx the in-process nonce can DRIFT; the
// pool re-syncs that account from the chain's pending nonce via `resyncNonce`.
// `checkBalances` reads each signer's on-chain USDC balance (gas is USDC on Arc)
// at runtime decimals and raises an alert below a threshold so the operator can
// refuel before settles start failing.
//
// SECURITY: keys are passed in as a parameter (read from RELAYER_SIGNER_KEYS in
// `.env.local` by the caller, server.ts in Plan 04). This module NEVER logs a key
// and never persists one. Single-process MVP: one signer key = one process
// (multi-process nonce coordination is deferred to Phase 8 per RESEARCH A2/A3).
import {
  createNonceManager,
  jsonRpc,
  type NonceManagerSource,
} from "viem/nonce";
import { privateKeyToAccount } from "viem/accounts";
import type {
  Account,
  Address,
  Chain,
  Hex,
  HttpTransport,
  PublicClient,
  WalletClient,
} from "viem";
import {
  createArcWalletClient,
  createArcPublicClient,
  arcTestnet,
  erc20Abi,
  USDC,
} from "@utter/chain";

/** A pooled relayer signer: its account, wallet client, and own nonce manager. */
export interface RelayerSigner {
  /** The signer's address (public; safe to log). */
  address: Address;
  /** The Viem account (carries the private key + per-signer nonce manager). */
  account: Account;
  /** The Arc wallet client bound to this account (write path). */
  wallet: WalletClient<HttpTransport, Chain, Account>;
  /** This account's dedicated nonce manager (one per account - Pattern 6). */
  nonceManager: ReturnType<typeof createNonceManager>;
}

/** A low-relayer-balance alert (gas is USDC on Arc). */
export interface RelayerBalanceAlert {
  /** The under-funded signer. */
  address: Address;
  /** Its current on-chain USDC balance (base units). */
  balance: bigint;
  /** The threshold it fell below (base units). */
  threshold: bigint;
}

/** Optional injectables (tests inject a mocked nonce source + public client). */
export interface RelayerPoolOptions {
  /** Nonce source per account; defaults to the JSON-RPC source (`getTransactionCount`). */
  nonceSource?: NonceManagerSource;
  /** Public client for the balance reads; defaults to a fresh Arc public client. */
  publicClient?: PublicClient;
}

/** The relayer pool: signer selection, per-signer nonce sequencing, low-balance alerts. */
export interface RelayerPool {
  /** All pooled signers (addresses are public; keys are never exposed here). */
  signers: readonly RelayerSigner[];
  /** Pick a signer for the next settle (round-robin / least-busy). */
  pickSigner(): RelayerSigner;
  /**
   * Reserve the next sequential EVM tx nonce for a signer via its nonce manager.
   * Concurrent calls on one signer are sequenced (no duplicate).
   */
  reserveNonce(address: Address): Promise<number>;
  /**
   * Re-sync a signer's nonce manager from the chain's pending nonce after a
   * reorg / dropped tx so it does not reuse a stale in-process value.
   */
  resyncNonce(address: Address): Promise<void>;
  /** Read each signer's on-chain USDC balance; return alerts for those below threshold. */
  checkBalances(thresholdBaseUnits: bigint): Promise<RelayerBalanceAlert[]>;
}

/**
 * Build a relayer pool from a set of private keys. Each key becomes a Viem local
 * account with its OWN `createNonceManager` so concurrent settles from one signer
 * never collide on the EVM tx nonce. `rpcUrl` overrides the Arc default (same
 * fallback as the chain factories). Keys are consumed locally and never logged.
 *
 * @throws if `keys` is empty - the facilitator cannot settle without a relayer.
 */
export function createRelayerPool(
  keys: readonly Hex[],
  rpcUrl?: string,
  options: RelayerPoolOptions = {},
): RelayerPool {
  if (keys.length === 0) {
    throw new Error(
      "createRelayerPool: no relayer keys - set RELAYER_SIGNER_KEYS in .env.local",
    );
  }

  const source = options.nonceSource ?? jsonRpc();
  const publicClient: PublicClient =
    options.publicClient ?? (createArcPublicClient(rpcUrl) as PublicClient);
  const chainId = arcTestnet.id;

  const signers: RelayerSigner[] = keys.map((pk) => {
    // One nonce manager PER account (Pattern 6) - shared managers would interleave
    // nonces across signers and defeat the point.
    const nonceManager = createNonceManager({ source });
    const account = privateKeyToAccount(pk, { nonceManager });
    const wallet = createArcWalletClient(account, rpcUrl);
    return { address: account.address, account, wallet, nonceManager };
  });

  const byAddress = new Map<string, RelayerSigner>(
    signers.map((s) => [s.address.toLowerCase(), s]),
  );

  let cursor = 0;

  function get(address: Address): RelayerSigner {
    const signer = byAddress.get(address.toLowerCase());
    if (!signer) throw new Error(`createRelayerPool: unknown signer ${address}`);
    return signer;
  }

  return {
    signers,

    pickSigner(): RelayerSigner {
      // Round-robin across the pool so load spreads evenly. (A least-busy variant
      // by in-flight count is a drop-in here when the settle path tracks it.) The
      // index is always in-bounds (the pool is non-empty, guarded at construction).
      const signer = signers[cursor % signers.length] as RelayerSigner;
      cursor += 1;
      return signer;
    },

    async reserveNonce(address: Address): Promise<number> {
      const signer = get(address);
      // `consume` gets-and-increments the nonce atomically; concurrent calls queue
      // through the manager's per-key promise, yielding sequential nonces.
      return signer.nonceManager.consume({
        address: signer.address,
        chainId,
        client: publicClient,
      });
    },

    async resyncNonce(address: Address): Promise<void> {
      const signer = get(address);
      // Drop the cached/in-process nonce so the next `consume`/`get` re-reads the
      // chain's pending nonce (getTransactionCount('pending')) - the reorg/dropped-tx
      // recovery path. `reset` clears both the nonce cache and the delta.
      signer.nonceManager.reset({ address: signer.address, chainId });
    },

    async checkBalances(thresholdBaseUnits: bigint): Promise<RelayerBalanceAlert[]> {
      const alerts: RelayerBalanceAlert[] = [];
      for (const signer of signers) {
        // Gas is USDC on Arc - read each signer's on-chain USDC ERC-20 balance
        // (base units). The threshold is supplied in base units by the caller;
        // decimals are read at runtime only where a HUMAN amount surfaces (the
        // operator-facing alert formatter), never to compare base-unit math here.
        const balance = (await publicClient.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [signer.address],
        })) as bigint;
        if (balance < thresholdBaseUnits) {
          alerts.push({ address: signer.address, balance, threshold: thresholdBaseUnits });
        }
      }
      return alerts;
    },
  };
}
