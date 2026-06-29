// playground-live.test.ts - the offline deterministic resolvePlaygroundHarness test.
//
// Proves the studio playground seam without ANY real infra: the live runner is injected
// (runLive), so no network, no chain, no funded wallet, no host deploy is touched. Cases:
//   (a) PLAYGROUND_HARNESS unset -> the resolver returns runPlaygroundHarness VERBATIM
//       (the frozen mock; the default is byte-unchanged) and it settles a paid result.
//   (b) PLAYGROUND_HARNESS=live -> the closure resolves the cardUrl via getCardUrl, calls
//       runLive with { cardUrl, endpointUrl (=base + /call), requestBody, env }, and maps
//       the TestEndpointResult to a PlaygroundHarnessResult with the 70/30 split derived
//       from the settled debit (10_000n -> creator 7_000n / treasury 3_000n), debits 1,
//       decimalsReads 1.
//   (c) live + getCardUrl returns null -> the closure throws "no card URL".
//   (d) live + the REAL liveTestEndpoint and env WITHOUT TEST_BUYER_PRIVATE_KEY (nothing
//       injected) -> the closure rejects with RequiresFundedWalletError (the armed-but-
//       unprovisioned path fail-louds BEFORE any network).
//   (e) deriveEndpointUrl strips the agent-card suffix and appends /call.
//
// Money discipline: the split is asserted as base-unit bigint over the SETTLED debit; no
// 1e6/6/18/decimals literal appears in any amount assertion.
import { describe, it, expect } from "vitest";
import {
  liveTestEndpoint,
  RequiresFundedWalletError,
  type TestEndpointResult,
  type LiveTestEndpointOptions,
} from "@utter/marketplace";
import {
  resolvePlaygroundHarness,
  deriveEndpointUrl,
} from "../app/adapter/playground-live.server";
import { runPlaygroundHarness } from "../app/adapter/playground-harness";

/** A valid bytes32 the mock harness pays against (the criterion-3 e2e id). */
const PAY_ID = `0x${"c3".repeat(32)}` as const;
/** A deployed-card URL shape (the discovery source). */
const CARD_URL = "https://echo.resources.example.com/.well-known/agent-card.json";

/**
 * Build a TestEndpointResult fixture with a chosen settled debit. Only the fields
 * mapLiveResult reads (debitAmount, paid) carry test-relevant values; the rest are
 * shape-valid placeholders. No decimals literal in any amount path.
 */
function makeLiveResult(debitAmount: bigint, paid = true): TestEndpointResult {
  return {
    paid,
    status: paid ? 200 : 402,
    cap: debitAmount,
    debitAmount,
    idemKey: `0x${"ab".repeat(32)}`,
    receipt: { ok: paid, amount: debitAmount.toString() },
    cardInputs: {
      escrow: "0x0000000000000000000000000000000000000000",
      asset: "0x0000000000000000000000000000000000000000",
      payTo: PAY_ID,
      pricing: { model: "metered", base: "0", perKB: "0", computeMultiplier: "0" },
      cap: debitAmount,
      bondPosted: true,
      verified: true,
    },
    recovered: null,
  };
}

describe("resolvePlaygroundHarness (the studio playground seam)", () => {
  it("(a) returns the frozen mock harness verbatim when PLAYGROUND_HARNESS is unset", async () => {
    const harness = resolvePlaygroundHarness(
      {} as NodeJS.ProcessEnv,
      { getCardUrl: async () => CARD_URL },
    );
    // The default path IS the frozen mock - the exact same function reference.
    expect(harness).toBe(runPlaygroundHarness);
    // And it settles a paid result against the in-process gate (proving the mock runs).
    const res = await harness(PAY_ID, { text: "hello" });
    expect(res.result.paid).toBe(true);
    expect(res.debits).toBe(1);
  });

  it("(b) live: resolves the card, calls runLive with the derived /call URL, and maps the 70/30 split", async () => {
    const seen: LiveTestEndpointOptions[] = [];
    const env = { PLAYGROUND_HARNESS: "live" } as unknown as NodeJS.ProcessEnv;
    const harness = resolvePlaygroundHarness(env, {
      getCardUrl: async () => CARD_URL,
      runLive: async (opts) => {
        seen.push(opts);
        // A 10_000n settled debit -> the 70/30 split is 7_000n / 3_000n (base units).
        return makeLiveResult(10_000n);
      },
    });

    const requestBody = { text: "hello" };
    const res = await harness(PAY_ID, requestBody);

    // runLive received the card + the derived /call endpoint + the request body + env.
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.cardUrl).toBe(CARD_URL);
    expect(call.endpointUrl).toBe("https://echo.resources.example.com/call");
    expect(call.requestBody).toBe(requestBody);
    expect(call.env).toBe(env);

    // The 70/30 split is derived from the SETTLED debit (base-unit bigint; no literal).
    expect(res.creatorShare).toBe(7_000n);
    expect(res.treasuryShare).toBe(3_000n);
    expect(res.creatorShare + res.treasuryShare).toBe(10_000n);
    expect(res.debits).toBe(1);
    expect(res.decimalsReads).toBe(1);
    expect(res.result.paid).toBe(true);
  });

  it("(c) live: throws 'no card URL' when the resource is not discoverable", async () => {
    const harness = resolvePlaygroundHarness(
      { PLAYGROUND_HARNESS: "live" } as unknown as NodeJS.ProcessEnv,
      { getCardUrl: async () => null, runLive: async () => makeLiveResult(10_000n) },
    );
    await expect(harness(PAY_ID, { text: "hello" })).rejects.toThrow(/no card URL/);
  });

  it("(d) live: surfaces RequiresFundedWalletError when armed without the funded key (no network)", async () => {
    // The REAL liveTestEndpoint, env WITHOUT TEST_BUYER_PRIVATE_KEY, nothing injected:
    // it throws RequiresFundedWalletError BEFORE any network or chain call.
    const harness = resolvePlaygroundHarness(
      { PLAYGROUND_HARNESS: "live" } as unknown as NodeJS.ProcessEnv,
      { getCardUrl: async () => CARD_URL, runLive: liveTestEndpoint },
    );
    await expect(harness(PAY_ID, { text: "hello" })).rejects.toBeInstanceOf(
      RequiresFundedWalletError,
    );
  });
});

describe("deriveEndpointUrl", () => {
  it("(e) strips the agent-card suffix and appends /call", () => {
    expect(deriveEndpointUrl(CARD_URL)).toBe("https://echo.resources.example.com/call");
    // A base URL with no card suffix and a trailing slash also yields a single /call.
    expect(deriveEndpointUrl("https://echo.resources.example.com/")).toBe(
      "https://echo.resources.example.com/call",
    );
    expect(deriveEndpointUrl("https://echo.resources.example.com")).toBe(
      "https://echo.resources.example.com/call",
    );
  });
});
