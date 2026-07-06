// demo-pay.test.ts - the OFFLINE proof for runDemoPay + parseDemoPayArgs. Everything is
// injected (fetcher + publicClient + walletClient + deposit + runLive seams), so the test
// makes NO real chain write and NO real network call. It pins the orchestration contract:
//   - a DRY-RUN reads + plans but performs ZERO deposits and ZERO pays;
//   - an APPLY funds ONCE sized to cap * calls, then pays exactly `calls` times, threading
//     the SAME wallet/client/fetcher into every pay (so no second key read happens);
//   - a poisoned/non-numeric card cap fails closed (never deposits, never pays);
//   - the arg parser is total (defaults, required --url, positive --calls, bytes32 id).
import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import {
  parseDemoPayArgs,
  runDemoPay,
  type HttpFetch,
} from "../src/demo-pay.js";
import type {
  DepositWalletClient,
  EnsureDepositOptions,
  EnsureDepositResult,
} from "../src/deposit.js";
import type { LiveTestEndpointOptions, TestEndpointResult } from "@utter/marketplace";

const BUYER = "0x1111111111111111111111111111111111111111" as const;
const CAP = 10000n; // the card pricing.max used throughout ($0.01 in 6-dp base units)

/** A minimal, valid-enough served card carrying the x402 pricing.max the sizing reads. */
function card(max = "10000"): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "utc",
    x402: {
      scheme: "utter-escrow",
      network: "eip155:5042002",
      asset: "0x3600000000000000000000000000000000000000",
      escrow: "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154",
      payTo: `0x${"f8".repeat(32)}`,
      pricing: { model: "metered", base: "10000", perKB: "0", max },
    },
  };
}

/** A fetcher that serves the given card JSON (200) for the discovery GET. */
function cardFetcher(cardJson: Record<string, unknown>): HttpFetch {
  return async () => new Response(JSON.stringify(cardJson), { status: 200 });
}

/** A public client whose escrow balanceOf returns a fixed value (base units). */
function publicClientWithBalance(balance: bigint): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return balance;
      throw new Error(`unexpected readContract ${functionName}`);
    },
  } as unknown as PublicClient;
}

/** A wallet stub exposing only the buyer address (deposit/pay are injected stubs). */
const walletClient = { account: { address: BUYER } } as unknown as DepositWalletClient;

/** A recording deposit seam. */
function recordingDeposit() {
  const calls: EnsureDepositOptions[] = [];
  const fn = async (o: EnsureDepositOptions): Promise<EnsureDepositResult> => {
    calls.push(o);
    return {
      deposited: true,
      approved: true,
      escrowBalance: 0n,
      topUp: o.neededCap,
      depositTx: `0x${"ab".repeat(32)}`,
    };
  };
  return { fn, calls };
}

/** A recording pay seam that always reports a paid $0.01 call. */
function recordingRunLive() {
  const calls: LiveTestEndpointOptions[] = [];
  const fn = async (o: LiveTestEndpointOptions): Promise<TestEndpointResult> => {
    calls.push(o);
    return {
      paid: true,
      status: 200,
      cap: CAP,
      debitAmount: CAP,
      idemKey: `0x${"11".repeat(32)}`,
      receipt: { amount: CAP.toString(), tx: `0x${"cd".repeat(32)}` },
      cardInputs: {} as never,
      recovered: null,
    } as unknown as TestEndpointResult;
  };
  return { fn, calls };
}

describe("runDemoPay", () => {
  it("DRY-RUN: plans without any deposit or pay", async () => {
    const deposit = recordingDeposit();
    const runLive = recordingRunLive();
    const logs: string[] = [];

    const result = await runDemoPay({
      cardUrl: "https://x.example",
      calls: 4,
      apply: false,
      walletClient,
      publicClient: publicClientWithBalance(0n),
      fetcher: cardFetcher(card()),
      deposit: deposit.fn,
      runLive: runLive.fn,
      log: (m) => logs.push(m),
    });

    expect(result.applied).toBe(false);
    expect(result.cap).toBe(CAP);
    expect(result.neededCap).toBe(CAP * 4n);
    expect(result.deposited).toBeNull();
    expect(result.runs).toEqual([]);
    // No writes and no pays happened.
    expect(deposit.calls).toHaveLength(0);
    expect(runLive.calls).toHaveLength(0);
    // The plan was surfaced and marked as a dry-run.
    expect(logs.join("\n")).toMatch(/DRY-RUN/);
  });

  it("APPLY: funds once sized to cap*calls, then pays exactly `calls` times", async () => {
    const deposit = recordingDeposit();
    const runLive = recordingRunLive();
    const publicClient = publicClientWithBalance(0n);

    const result = await runDemoPay({
      cardUrl: "https://x.example",
      calls: 3,
      apply: true,
      walletClient,
      publicClient,
      fetcher: cardFetcher(card()),
      deposit: deposit.fn,
      runLive: runLive.fn,
      log: () => {},
    });

    // Deposit-once, sized to the whole run.
    expect(deposit.calls).toHaveLength(1);
    expect(deposit.calls[0]!.neededCap).toBe(CAP * 3n);
    expect(deposit.calls[0]!.buyer).toBe(BUYER);
    // Exactly `calls` pays, each threading the SAME wallet/client/fetcher (no new key read),
    // against the derived /call endpoint and the full agent-card URL.
    expect(runLive.calls).toHaveLength(3);
    for (const c of runLive.calls) {
      expect(c.endpointUrl).toBe("https://x.example/call");
      expect(c.cardUrl).toBe("https://x.example/.well-known/agent-card.json");
      expect(c.buyerWallet).toBe(walletClient);
      expect(c.publicClient).toBe(publicClient);
    }
    expect(result.applied).toBe(true);
    expect(result.paidCount).toBe(3);
    expect(result.totalDebited).toBe(CAP * 3n);
    expect(result.runs).toHaveLength(3);
  });

  it("APPLY: surfaces the on-chain settlement tx + an explorer link per paid call", async () => {
    const logs: string[] = [];
    const result = await runDemoPay({
      cardUrl: "https://x.example",
      calls: 2,
      apply: true,
      walletClient,
      publicClient: publicClientWithBalance(0n),
      fetcher: cardFetcher(card()),
      deposit: recordingDeposit().fn,
      runLive: recordingRunLive().fn,
      env: { ARC_EXPLORER: "https://testnet.arcscan.app" } as NodeJS.ProcessEnv,
      log: (m) => logs.push(m),
    });
    // The settlement tx hashes are collected and each is linked to the explorer.
    expect(result.settlementTxs).toEqual([`0x${"cd".repeat(32)}`, `0x${"cd".repeat(32)}`]);
    const joined = logs.join("\n");
    expect(joined).toMatch(new RegExp(`tx=0x${"cd".repeat(32)}`));
    expect(joined).toMatch(new RegExp(`testnet\\.arcscan\\.app/tx/0x${"cd".repeat(32)}`));
  });

  it("fails closed on a non-numeric card cap (no deposit, no pay)", async () => {
    const deposit = recordingDeposit();
    const runLive = recordingRunLive();

    await expect(
      runDemoPay({
        cardUrl: "https://x.example",
        calls: 1,
        apply: true,
        walletClient,
        publicClient: publicClientWithBalance(0n),
        fetcher: cardFetcher(card("1e9")), // hostile: not a plain base-unit integer
        deposit: deposit.fn,
        runLive: runLive.fn,
        log: () => {},
      }),
    ).rejects.toThrow(/not a base-unit integer/);

    expect(deposit.calls).toHaveLength(0);
    expect(runLive.calls).toHaveLength(0);
  });

  it("preserves a full agent-card URL and still derives the /call endpoint", async () => {
    const runLive = recordingRunLive();
    await runDemoPay({
      cardUrl: "https://x.example/.well-known/agent-card.json",
      calls: 1,
      apply: true,
      walletClient,
      publicClient: publicClientWithBalance(CAP), // already funded -> deposit is a no-op write path
      fetcher: cardFetcher(card()),
      deposit: recordingDeposit().fn,
      runLive: runLive.fn,
      log: () => {},
    });
    expect(runLive.calls[0]!.cardUrl).toBe("https://x.example/.well-known/agent-card.json");
    expect(runLive.calls[0]!.endpointUrl).toBe("https://x.example/call");
  });
});

describe("parseDemoPayArgs", () => {
  it("parses url + calls + apply + resource-id + body with sane defaults", () => {
    const args = parseDemoPayArgs([
      "--url",
      "https://x.example",
      "--calls",
      "5",
      "--apply",
      "--resource-id",
      `0x${"ab".repeat(32)}`,
      "--body",
      '{"text":"hi"}',
    ]);
    expect(args.cardUrl).toBe("https://x.example");
    expect(args.calls).toBe(5);
    expect(args.apply).toBe(true);
    expect(args.resourceId).toBe(`0x${"ab".repeat(32)}`);
    expect(args.requestBody).toEqual({ text: "hi" });
  });

  it("defaults calls=1, apply=false and requires --url", () => {
    const args = parseDemoPayArgs(["--url", "https://x.example"]);
    expect(args.calls).toBe(1);
    expect(args.apply).toBe(false);
    expect(() => parseDemoPayArgs([])).toThrow(/--url .* is required/);
  });

  it("tolerates a forwarded `--` separator (pnpm run <script> -- <args>)", () => {
    const args = parseDemoPayArgs(["--", "--url", "https://x.example", "--calls", "3", "--apply"]);
    expect(args.cardUrl).toBe("https://x.example");
    expect(args.calls).toBe(3);
    expect(args.apply).toBe(true);
  });

  it("rejects a non-positive --calls, a bad --resource-id, and unknown flags", () => {
    expect(() => parseDemoPayArgs(["--url", "u", "--calls", "0"])).toThrow(/positive integer/);
    expect(() => parseDemoPayArgs(["--url", "u", "--resource-id", "0xdead"])).toThrow(/bytes32/);
    expect(() => parseDemoPayArgs(["--url", "u", "--nope"])).toThrow(/unknown flag/);
  });
});
