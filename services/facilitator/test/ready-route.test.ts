// ready-route suite (Provisioning track, subtask 4): GET /health (a constant liveness
// check) + GET /ready (the store-aware readiness probe) on the facilitator app.
//
// Fully offline + in-process: createApp driven through app.request. The money-path deps
// are present only to satisfy AppDeps; this suite never hits /verify or /settle. The
// only varying dep is storeProbe:
//   - /health -> 200 {ok:true,service:'facilitator'} WITHOUT ever calling the probe
//   - /ready with a resolving probe -> 200 {ready:true}
//   - /ready with a THROWING probe whose message carries a fake secret -> 503
//     {ready:false}, and the body/text contains NO 'secret' / 'postgres://' (VALUE-FREE)
//   - /ready with NO probe wired (in-memory dev) -> 200 {ready:true}
import { describe, it, expect, vi } from "vitest";
import { type Hex, type PublicClient } from "viem";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
} from "@utter/x402-arc";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC } from "@utter/chain";
import { createApp, type AppDeps } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import type { RelayerPool } from "../src/relayer";

// A connection-string-shaped secret the throwing probe leaks into err.message, so the
// value-free assertion proves the catch swallows it and never echoes it.
const FAKE_SECRET = "postgres://secret@host:5432/db";

/** A no-op relayer pool (this suite never settles). */
function noopRelayerPool(): RelayerPool {
  return {
    signers: [],
    pickSigner: () => {
      throw new Error("ready-route test never settles");
    },
    reserveNonce: async () => 0,
    resyncNonce: async () => {},
    checkBalances: async () => [],
  } as unknown as RelayerPool;
}

/** A stub public client (unused by /health or /ready; present to satisfy AppDeps). */
function stubPublicClient(): PublicClient {
  return {} as unknown as PublicClient;
}

/** Build the app over an optional storeProbe; everything else is in-memory. */
function makeApp(storeProbe?: () => Promise<void>) {
  const deps: AppDeps = {
    store: new InMemoryPaymentStore(),
    resultStore: new InMemoryResultStore(),
    relayerPool: noopRelayerPool(),
    publicClient: stubPublicClient(),
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: 30,
    settleBufferSeconds: 90,
    storeProbe,
  };
  return createApp(deps);
}

describe("facilitator GET /health (constant liveness)", () => {
  it("returns 200 {ok:true,service:'facilitator'} without calling the probe", async () => {
    const probe = vi.fn(async () => {});
    const app = makeApp(probe);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "facilitator" });
    // Liveness MUST not depend on a backend: the probe is never invoked.
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("facilitator GET /ready (store-aware readiness)", () => {
  it("returns 200 {ready:true} when the probe resolves", async () => {
    const probe = vi.fn(async () => {});
    const app = makeApp(probe);
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns a VALUE-FREE 503 {ready:false} when the probe throws (no secret leaked)", async () => {
    const probe = vi.fn(async () => {
      throw new Error(`connect failed: ${FAKE_SECRET}`);
    });
    const app = makeApp(probe);
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const json = (await res.clone().json()) as Record<string, unknown>;
    expect(json).toEqual({ ready: false });
    // Value-free: neither the parsed body nor the raw text may carry the secret.
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain(FAKE_SECRET);
  });

  it("returns 200 {ready:true} when NO probe is wired (in-memory dev)", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });
});
