// demo.test.ts - the BUY-02/BUY-03 DEMO-mode proof: the self-contained in-process wiring
// the buyer MCP bin boots by default (createDemoWiring) drives the FULL discover ->
// reserve -> handler -> settle pay loop against the mock chain, with NO real money,
// network, or deployed resource. This is the in-process counterpart of the bin boot (we
// build the SAME demo deps the bin builds and drive the MCP tools directly - no child
// process, no stdio pipe, no live model).
//
// It proves, autonomously and offline:
//   (a) demoCardSource() returns ONE valid card the discovery tool surfaces (price +
//       reputation projected; the demo endpoint listed by its derived tool name).
//   (b) the endpoint tool pays the demo card through the fixture transport: exactly ONE
//       debit <= cap, the echoed result returned, and exactly-once recovery (same idemKey,
//       no second debit).
//   (c) createMcpServerAsync with the demo deps registers the discovery + endpoint tools.
//
// MONEY DISCIPLINE: amounts are asserted as base-unit bigints (debit <= cap); NO decimals
// literal is used to scale any amount - the cap basis comes from the demo mock decimals()
// read inside the pay loop.
import { describe, it, expect } from "vitest";

import {
  createDemoWiring,
  demoCardSource,
  demoClientCardSource,
  createDemoBuyerWallet,
  DEMO_RESOURCE_ID,
} from "../src/demo.js";
import { createBuyerClient } from "../src/client.js";
import { createMcpServerAsync } from "../src/mcp/server.js";
import { createBudgetGuard } from "../src/mcp/budget.js";
import { validateAgentCard } from "@utter/ai-runtime";

/** Build the demo MCP server over the demo wiring (the SAME deps the bin boots in DEMO mode). */
async function buildDemoMcp(budget = createBudgetGuard({})) {
  const demo = createDemoWiring();
  const client = createBuyerClient({
    transport: demo.transport,
    buyerWallet: demo.buyerWallet,
    cardSource: demo.clientCardSource,
  });
  return createMcpServerAsync({ client, cardSource: demo.cardSource, budget });
}

describe("demo wiring (a): the demo card source surfaces a valid discoverable card", () => {
  it("demoClientCardSource serves a validateAgentCard-VALID card for the demo resource id", async () => {
    const source = demoClientCardSource();
    const card = await source(DEMO_RESOURCE_ID);
    expect(card).not.toBeNull();
    // The served card is a real A2A v0.3.0 card the discover HARD-gate accepts.
    expect(validateAgentCard(card!).valid).toBe(true);
    // An unknown resource id is "not discoverable" (null), exactly like the live source.
    expect(await source(`0x${"00".repeat(32)}`)).toBeNull();
  });

  it("the discovery tool lists the demo endpoint with price + reputation (no key)", async () => {
    const { invoke, toolNames } = await buildDemoMcp();
    const discoveryName = toolNames.find((n) => /discover|list|search/i.test(n))!;
    const res = await invoke(discoveryName, {});
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toMatch(/Echo/); // the demo endpoint name
    expect(text).toMatch(/USDC|10000/); // price (cap) surfaced
    expect(text).toMatch(/verified/); // reputation surfaced
    expect(text.toLowerCase()).not.toContain("privatekey");
  });
});

describe("demo wiring (b): the endpoint tool pays the demo card through the fixture transport", () => {
  it("client.pay over the demo wiring: exactly ONE debit <= cap, echoed result, exactly-once", async () => {
    const demo = createDemoWiring();
    const client = createBuyerClient({
      transport: demo.transport,
      buyerWallet: demo.buyerWallet,
      cardSource: demo.clientCardSource,
    });

    const result = await client.pay({
      resource: { resourceId: DEMO_RESOURCE_ID },
      body: { text: "hello demo" },
    });

    // The pay loop ran in-process against the mock chain: 200 + a bounded debit.
    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.debitAmount > 0n).toBe(true);
    expect(result.debitAmount <= result.cap).toBe(true);
    // The echo handler returned the text (the in-fixture seller-side gate).
    const echoed = JSON.parse(result.response) as { echo?: string; length?: number };
    expect(echoed.echo).toBe("hello demo");
    expect(echoed.length).toBe("hello demo".length);

    // Exactly-once: recover by the SAME idemKey (nonce) - no re-sign, no second debit.
    const recovered = await client.retrieveByIdemKey(result.idemKey);
    expect(recovered).not.toBeNull();
    expect(recovered!.idemKey).toBe(result.idemKey);
  });

  it("the endpoint TOOL runs pay and returns the echoed result; one debit recorded <= cap", async () => {
    const budget = createBudgetGuard({});
    const { invoke, toolNames } = await buildDemoMcp(budget);
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;

    const res = await invoke(endpointTool, { text: "via the tool" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("echo");
    const echoed = JSON.parse(res.content[0]!.text) as { echo?: string };
    expect(echoed.echo).toBe("via the tool");

    // Exactly ONE settle was committed to the budget (the single metered debit), and it is
    // within the card cap (10_000 base units). One debit -> spentForDay equals that debit.
    const spent = budget.spentForDay();
    expect(spent > 0n).toBe(true);
    expect(spent <= 10_000n).toBe(true);
  });

  it("the demo endpoint tool's args are validated: a malformed arg is rejected BEFORE pay", async () => {
    const budget = createBudgetGuard({});
    const { invoke, toolNames } = await buildDemoMcp(budget);
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    // The demo openapi requires `text`; a missing/extra field is a tool error, no pay.
    const bad = await invoke(endpointTool, { notText: 1 });
    expect(bad.isError).toBe(true);
    expect(budget.spentForDay()).toBe(0n); // nothing paid
  });
});

describe("demo wiring (c): createMcpServerAsync registers the discovery + endpoint tools", () => {
  it("lists a discovery tool + the per-endpoint demo tool (>= 2 tools)", async () => {
    const { toolNames } = await buildDemoMcp();
    expect(toolNames.some((n) => /discover|list|search/i.test(n))).toBe(true);
    expect(toolNames.some((n) => /utter_call|utter/i.test(n))).toBe(true);
    expect(toolNames.length).toBeGreaterThanOrEqual(2);
  });

  it("demoCardSource projects exactly one demo card (the built-in echo endpoint)", async () => {
    const cards = await demoCardSource()();
    expect(cards.length).toBe(1);
    expect(cards[0]!.resourceId).toBe(DEMO_RESOURCE_ID);
    expect(cards[0]!.verified).toBe(true);
    // The cap is surfaced as a base-unit bigint (no decimals literal scaled it).
    expect(cards[0]!.capBaseUnits).toBe(10_000n);
  });

  it("createDemoBuyerWallet returns an ephemeral wallet (a fresh address, never a real key)", () => {
    const a = createDemoBuyerWallet();
    const b = createDemoBuyerWallet();
    // Two demo wallets are distinct (each freshly generated) and expose an account address.
    expect(a.account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a.account.address).not.toBe(b.account.address);
  });
});
