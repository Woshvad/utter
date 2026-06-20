// relayer-nonce-pool suite (PAY-10): the per-signer nonce manager + pool
// distribution + drift re-sync + low-USDC alert. Runs fully OFFLINE - a mocked
// nonce source (no eth_getTransactionCount RPC) and a mocked balanceOf - so the
// concurrency + drift + alert behavior is proven with no live chain. Keys are
// generated fixtures; the real keys come from RELAYER_SIGNER_KEYS in .env.local
// (read by server.ts in Plan 04), never committed and never logged.
import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { createRelayerPool } from "../src/relayer";

/**
 * A mocked NonceManagerSource backed by an in-memory per-address counter that
 * simulates `eth_getTransactionCount(address, 'pending')`. `set` advances the
 * backing counter on a confirmed send (mirroring the chain). A test can force
 * drift by mutating the backing counter directly.
 */
function mockNonceSource(initial: Record<string, number> = {}) {
  const chainNonce: Record<string, number> = {};
  for (const [k, v] of Object.entries(initial)) chainNonce[k.toLowerCase()] = v;
  const source = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async get({ address }: { address: string; chainId: number; client: any }): Promise<number> {
      return chainNonce[address.toLowerCase()] ?? 0;
    },
    async set(_params: { address: string; chainId: number }, _nonce: number): Promise<void> {
      // no-op: the mock counter is advanced explicitly by the harness/confirm step
    },
  };
  return {
    source,
    /** Simulate a confirmed tx advancing the chain's pending nonce. */
    confirm(address: string) {
      const key = address.toLowerCase();
      chainNonce[key] = (chainNonce[key] ?? 0) + 1;
    },
    /** Force a stale/drifted chain nonce (reorg/dropped-tx harness). */
    setChainNonce(address: string, n: number) {
      chainNonce[address.toLowerCase()] = n;
    },
  };
}

/** A balanceOf-only mock public client for the low-balance check. */
function mockBalanceClient(balances: Record<string, bigint>) {
  return {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (functionName === "balanceOf") {
        return balances[(args[0] as string).toLowerCase()] ?? 0n;
      }
      throw new Error(`mockBalanceClient: unexpected ${functionName}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("relayer-nonce-pool", () => {
  it("Test 1 (per-signer sequential nonces): concurrent sends on one signer get sequential, no-duplicate nonces", async () => {
    const keys: Hex[] = [generatePrivateKey(), generatePrivateKey()];
    const mock = mockNonceSource();
    const pool = createRelayerPool(keys, undefined, { nonceSource: mock.source });

    const signer = pool.signers[0]!;
    // Issue N concurrent nonce reservations on ONE signer; the per-signer nonce
    // manager must sequence them with no duplicate.
    const N = 8;
    const nonces = await Promise.all(
      Array.from({ length: N }, () => pool.reserveNonce(signer.address)),
    );

    const sorted = [...nonces].sort((a, b) => a - b);
    expect(new Set(nonces).size, "no duplicate nonce across concurrent sends").toBe(N);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i)); // 0..N-1 sequential
  });

  it("Test 2 (pool distributes): pickSigner returns more than one distinct signer", async () => {
    const keys: Hex[] = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
    const mock = mockNonceSource();
    const pool = createRelayerPool(keys, undefined, { nonceSource: mock.source });

    const picked = new Set<string>();
    for (let i = 0; i < 12; i++) picked.add(pool.pickSigner().address.toLowerCase());

    expect(picked.size, "round-robin must spread load across signers").toBeGreaterThan(1);
  });

  it("Test 3 (nonce-drift recovery): a stale in-process nonce is re-synced from getTransactionCount('pending')", async () => {
    const keys: Hex[] = [generatePrivateKey()];
    const mock = mockNonceSource();
    const pool = createRelayerPool(keys, undefined, { nonceSource: mock.source });
    const signer = pool.signers[0]!;

    // Consume nonce 0; the manager now expects 1 next.
    const n0 = await pool.reserveNonce(signer.address);
    expect(n0).toBe(0);

    // Simulate a reorg/dropped tx: the chain's pending nonce JUMPS forward to 5
    // (e.g. other txs from this EOA confirmed out of band). A stale in-process
    // counter would hand back 1; after a drift re-sync the pool must NOT reuse the
    // stale value and must continue from the chain truth.
    mock.setChainNonce(signer.address, 5);
    await pool.resyncNonce(signer.address);
    const next = await pool.reserveNonce(signer.address);

    expect(next, "drift re-sync must not reuse the stale nonce").toBeGreaterThanOrEqual(5);
    expect(next).not.toBe(1);
  });

  it("Test 4 (low-balance alert): checkBalances flags a signer below threshold and not above", async () => {
    const lowPk = generatePrivateKey();
    const highPk = generatePrivateKey();
    const lowAddr = privateKeyToAccount(lowPk).address;
    const highAddr = privateKeyToAccount(highPk).address;
    const mock = mockNonceSource();
    const client = mockBalanceClient({
      [lowAddr.toLowerCase()]: 1_000n,
      [highAddr.toLowerCase()]: 1_000_000n,
    });
    const pool = createRelayerPool([lowPk, highPk], undefined, {
      nonceSource: mock.source,
      publicClient: client,
    });

    const threshold = 100_000n;
    const alerts = await pool.checkBalances(threshold);

    const flagged = alerts.map((a) => a.address.toLowerCase());
    expect(flagged).toContain(lowAddr.toLowerCase());
    expect(flagged, "a signer above threshold must NOT be flagged").not.toContain(
      highAddr.toLowerCase(),
    );
    const lowAlert = alerts.find((a) => a.address.toLowerCase() === lowAddr.toLowerCase());
    expect(lowAlert?.balance).toBe(1_000n);
    expect(lowAlert?.threshold).toBe(threshold);
  });
});
