// SCL-03 tests: StableFxAdapter (mock default / gated live) + PayoutRouter
// (USDC default / EURC per-payee opt-in, runtime decimals()).
//
// The seam mirrors packages/buyer-sdk/src/transport.ts (fixture default +
// RequiresLive* gated) and services/facilitator/src/settle.ts (the discriminant
// branch + no-decimals-literal money discipline). No network/chain is touched:
// MockStableFx is deterministic and the decimals() read is satisfied by an
// injected reader that returns its value from a decimals() call, never a literal.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { EURC, USDC } from "@utter/chain";
import {
  MockStableFx,
  LiveStableFx,
  RequiresLiveStableFx,
  PayoutRouter,
  type PayoutAsset,
  type DecimalsReader,
  type PayeeConfig,
} from "../src/index";

// A decimals() reader that returns the value FROM a (mock) decimals() call, never a
// literal - the runtime-decimals enforcement point. Both USDC and EURC are 6dp on
// Arc; the reader proves the router never hardcodes that.
function fakeDecimalsReader(map: Record<string, number>): DecimalsReader {
  return {
    async decimals(token) {
      const key = token.toLowerCase();
      const d = map[key];
      if (d === undefined) {
        throw new Error(`fakeDecimalsReader: no decimals() stubbed for ${token}`);
      }
      return d;
    },
  };
}

const STD_DECIMALS = fakeDecimalsReader({
  [USDC.toLowerCase()]: 6,
  [EURC.toLowerCase()]: 6,
});

/** A typed dummy payee address (0x + 40 hex). */
function payeeAddr(byte: string): Address {
  return ("0x" + byte.repeat(20)) as Address;
}

describe("MockStableFx (the deterministic autonomous default)", () => {
  it("quote(USDC->EURC, amount) returns a deterministic quote, no network", async () => {
    const fx = new MockStableFx();
    const q1 = await fx.quote(USDC, EURC, 1_000_000n);
    const q2 = await fx.quote(USDC, EURC, 1_000_000n);
    expect(q1.outAmount).toBe(q2.outAmount); // deterministic
    expect(q1.from.toLowerCase()).toBe(USDC.toLowerCase());
    expect(q1.to.toLowerCase()).toBe(EURC.toLowerCase());
    expect(typeof q1.outAmount).toBe("bigint");
    expect(q1.inAmount).toBe(1_000_000n);
  });

  it(".swap(quote) executes deterministically and returns the swapped EURC amount", async () => {
    const fx = new MockStableFx();
    const q = await fx.quote(USDC, EURC, 2_000_000n);
    const out = await fx.swap(q);
    expect(out).toBe(q.outAmount);
    expect(typeof out).toBe("bigint");
  });
});

describe("LiveStableFx (operator-gated, fail-loud)", () => {
  it("quote throws RequiresLiveStableFx with the code discriminant", async () => {
    const fx = new LiveStableFx();
    await expect(fx.quote(USDC, EURC, 1_000_000n)).rejects.toBeInstanceOf(
      RequiresLiveStableFx,
    );
    try {
      await fx.quote(USDC, EURC, 1_000_000n);
    } catch (err) {
      expect((err as RequiresLiveStableFx).code).toBe("requiresLiveStableFx");
    }
  });

  it("swap throws RequiresLiveStableFx (autonomous path never reaches it)", async () => {
    const fx = new LiveStableFx();
    await expect(
      fx.swap({ from: USDC, to: EURC, inAmount: 1n, outAmount: 1n }),
    ).rejects.toBeInstanceOf(RequiresLiveStableFx);
  });
});

describe("PayoutRouter (USDC default / EURC per-payee opt-in)", () => {
  it("routes a USDC payout (the default asset) in USDC with a runtime decimals read", async () => {
    const router = new PayoutRouter({
      fx: new MockStableFx(),
      decimalsReader: STD_DECIMALS,
    });
    const config: PayeeConfig = { payee: payeeAddr("11"), asset: "USDC" };
    const result = await router.route(config, 5_000_000n);
    expect(result.asset).toBe<PayoutAsset>("USDC");
    expect(result.token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(result.amount).toBe(5_000_000n); // USDC pays straight through
    expect(result.decimals).toBe(6); // came from the decimals() read, not a literal
    expect(result.swapped).toBe(false);
  });

  it("routes an EURC payout (per-payee opt-in) via MockStableFx quote+swap", async () => {
    const fx = new MockStableFx();
    const router = new PayoutRouter({ fx, decimalsReader: STD_DECIMALS });
    const config: PayeeConfig = { payee: payeeAddr("22"), asset: "EURC" };
    const amount = 3_000_000n;
    const result = await router.route(config, amount);
    const expectedQuote = await fx.quote(USDC, EURC, amount);
    expect(result.asset).toBe<PayoutAsset>("EURC");
    expect(result.token.toLowerCase()).toBe(EURC.toLowerCase());
    expect(result.amount).toBe(expectedQuote.outAmount); // routed through the swap
    expect(result.decimals).toBe(6); // EURC decimals read at runtime, never hardcoded
    expect(result.swapped).toBe(true);
  });

  it("reads decimals() at runtime for BOTH assets (the reader is consulted, not a literal)", async () => {
    const seen: string[] = [];
    const trackingReader: DecimalsReader = {
      async decimals(token) {
        seen.push(token.toLowerCase());
        return 6;
      },
    };
    const router = new PayoutRouter({
      fx: new MockStableFx(),
      decimalsReader: trackingReader,
    });
    await router.route({ payee: payeeAddr("33"), asset: "USDC" }, 1_000_000n);
    expect(seen).toContain(USDC.toLowerCase());
    seen.length = 0;
    await router.route({ payee: payeeAddr("44"), asset: "EURC" }, 1_000_000n);
    expect(seen).toContain(EURC.toLowerCase());
  });

  it("takes the asset from per-payee config, not a caller field (a caller cannot flip it)", async () => {
    const router = new PayoutRouter({
      fx: new MockStableFx(),
      decimalsReader: STD_DECIMALS,
    });
    // The route() signature accepts ONLY (config, amount) - there is no caller-supplied
    // asset override argument. The asset is read off the per-payee config object, so a
    // caller cannot pass EURC for a USDC-configured payee.
    const usdcPayee: PayeeConfig = { payee: payeeAddr("55"), asset: "USDC" };
    const result = await router.route(usdcPayee, 1_000_000n);
    expect(result.asset).toBe<PayoutAsset>("USDC");
    // route() is binary in (config, amount): no third asset arg exists to override with.
    expect(router.route.length).toBe(2);
  });
});

describe("no decimals literal in the money path (T-08-UNITCONFUSION)", () => {
  it("payout-router.ts contains no 6 / 1e6 / 10**6 amount literal", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/payout-router.ts", import.meta.url)),
      "utf8",
    );
    // strip line + block comments before scanning (prose may mention "6 decimals")
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\b1e6\b/);
    expect(code).not.toMatch(/10\s*\*\*\s*6/);
    expect(code).not.toMatch(/\b6\b/); // no bare 6 decimals literal anywhere in code
  });
});
