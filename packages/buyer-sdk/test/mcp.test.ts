// mcp.test.ts - the BUY-02 + BUY-03 MCP server proof (tool handlers in-process; NO live
// model, NO live chain). It proves, autonomously:
//   - the budget guard (T-07-DENIALOFWALLET): per-tool/-day soft caps over the on-chain
//     hard cap; check() returns a TYPED allow/deny (never a throw that could leak a key);
//     record() advances the totals; an unset cap is unbounded.
//   - the tool builders (BUY-02): buildEndpointTool derives an inputSchema from the
//     resource openapi.json (passthrough validated server-side), surfaces price +
//     reputation in the description, and holds NO buyer key in the config.
//   - createMcpServer (BUY-02/BUY-03): registers a discovery tool + per-endpoint tools;
//     a tool call runs client.pay and returns the validated result; the buyer key is
//     NEVER a tool arg/return/log; a budget-exceeded call returns a tool error and does
//     NOT pay; the openapi-derived inputSchema rejects malformed args BEFORE pay.
//   - stdout-clean (Pitfall 1 / T-07-STDOUT): src/mcp + src/bin carry zero console.log
//     and zero BUYER_PRIVATE_KEY reference (grep assert).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createBudgetGuard } from "../src/mcp/budget.js";
import {
  buildDiscoveryTool,
  buildEndpointTool,
  endpointToolName,
  type DiscoveredCard,
} from "../src/mcp/tools.js";
import { createMcpServer, createMcpServerAsync } from "../src/mcp/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../src");

const RESOURCE = `0x${"e7".repeat(32)}` as const;
const ESCROW = `0x${"11".repeat(20)}` as const;
const ASSET = `0x${"22".repeat(20)}` as const;

/** The openapi.json a resource bundle ships - the inputSchema is derived from this. */
const OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "weather", version: "1.0.0" },
  paths: {
    "/call": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["city"],
                properties: { city: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  },
};

/** A discovered card projection (price + reputation; NEVER a key). */
function discoveredCard(overrides: Partial<DiscoveredCard> = {}): DiscoveredCard {
  return {
    resourceId: RESOURCE,
    name: "Weather (Utter)",
    escrow: ESCROW,
    asset: ASSET,
    payTo: RESOURCE,
    pricing: { base: "5000", perKB: "100", max: "10000", model: "metered" },
    capBaseUnits: 10_000n,
    verified: true,
    agentId: "42",
    bondPosted: true,
    openapi: OPENAPI,
    ...overrides,
  };
}

describe("createBudgetGuard (T-07-DENIALOFWALLET)", () => {
  it("allows within the per-tool cap and denies (typed, no throw) when it would be exceeded", () => {
    const guard = createBudgetGuard({ perToolCapBaseUnits: 1000n });
    expect(guard.check("t", 600n)).toEqual({ ok: true });
    guard.record("t", 600n);
    // 600 recorded + 500 would exceed 1000 -> typed deny (not a throw).
    const denied = guard.check("t", 500n);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/tool/i);
  });

  it("enforces the per-day cap across DIFFERENT tools", () => {
    const guard = createBudgetGuard({ perDayCapBaseUnits: 1000n });
    expect(guard.check("a", 700n)).toEqual({ ok: true });
    guard.record("a", 700n);
    const denied = guard.check("b", 400n); // 700 + 400 > 1000 day cap
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/day/i);
  });

  it("treats an UNSET cap as unbounded for that dimension", () => {
    const guard = createBudgetGuard({}); // both unset
    guard.record("t", 10n ** 30n);
    expect(guard.check("t", 10n ** 30n)).toEqual({ ok: true });
  });

  it("never relaxes a per-call amount that fits both caps", () => {
    const guard = createBudgetGuard({ perToolCapBaseUnits: 5000n, perDayCapBaseUnits: 8000n });
    expect(guard.check("t", 5000n)).toEqual({ ok: true });
    guard.record("t", 5000n);
    // per-tool now full; the day cap still has 3000 room but the tool is capped.
    expect(guard.check("t", 1n).ok).toBe(false);
  });

  // WR-02: RESERVE-before-pay closes the concurrency gap. N parallel reservations all see
  // each other's PENDING spend, so the cap is never collectively overshot.
  it("reserve() admits only as many concurrent calls as the cap allows (WR-02 concurrency)", () => {
    // Per-day cap admits exactly 3 calls of 1000 each (cap 3000); the per-tool cap is open.
    const guard = createBudgetGuard({ perDayCapBaseUnits: 3000n });
    // Simulate 5 PARALLEL reservations BEFORE any commits (the TOCTOU window): each reserves
    // 1000. Only 3 may be admitted; the 4th and 5th must be denied even though nothing has
    // been committed yet (the old check-then-record path would admit all 5).
    const outcomes = Array.from({ length: 5 }, () => guard.reserve("t", 1000n));
    const admitted = outcomes.filter((o) => o.ok);
    const denied = outcomes.filter((o) => !o.ok);
    expect(admitted.length).toBe(3);
    expect(denied.length).toBe(2);
    // Committing the admitted reservations to a metered actual (800 each) keeps the day
    // total <= cap; the released (denied) reservations never consumed room.
    for (const o of admitted) if (o.ok) guard.commit(o, 800n);
    expect(guard.spentForDay()).toBe(2400n);
    expect(guard.spentForDay() <= 3000n).toBe(true);
  });

  it("release() returns reserved room so a failed pay does not leak budget (WR-02/WR-03)", () => {
    const guard = createBudgetGuard({ perDayCapBaseUnits: 1000n });
    const r1 = guard.reserve("t", 1000n);
    expect(r1.ok).toBe(true);
    // While r1 is held, a second reservation is denied (the cap is fully reserved).
    expect(guard.reserve("t", 1n).ok).toBe(false);
    // The pay fails -> release r1; the room is now free again.
    if (r1.ok) guard.release(r1);
    expect(guard.reserve("t", 1000n).ok).toBe(true);
    // A released reservation committed nothing.
    expect(guard.spentForDay()).toBe(0n);
  });
});

describe("buildEndpointTool (BUY-02): inputSchema from openapi + price/reputation in metadata", () => {
  it("derives an inputSchema and surfaces price + reputation in the description, with NO key in the config", () => {
    const card = discoveredCard();
    const built = buildEndpointTool(card, async () => ({ response: "{}", debitAmount: 1n }));
    expect(built.name).toMatch(/utter/i);
    // inputSchema is a zod raw shape (a record of schemas) derived from the openapi.
    expect(built.config.inputSchema).toBeDefined();
    expect(typeof built.config.inputSchema).toBe("object");
    // Price + reputation surfaced to the model in the description.
    expect(built.config.description).toMatch(/USDC/);
    expect(built.config.description).toMatch(/verified|reputation/i);
    expect(built.config.description).toContain("42"); // agentId
    // NO key material anywhere in the serialized config.
    const serial = JSON.stringify(built.config, (_k, v) =>
      typeof v === "bigint" ? v.toString() : typeof v === "function" ? "[fn]" : v,
    );
    expect(serial.toLowerCase()).not.toContain("privatekey");
    expect(serial).not.toContain("BUYER_PRIVATE_KEY");
  });

  it("validates args against the openapi and REJECTS a malformed arg BEFORE pay (V5)", async () => {
    const card = discoveredCard();
    let paid = false;
    const built = buildEndpointTool(card, async () => {
      paid = true;
      return { response: "{}", debitAmount: 1n };
    });
    // Missing the required "city" -> a tool error result, no pay.
    const bad = await built.handler({ wrongField: 1 });
    expect(bad.isError).toBe(true);
    expect(paid).toBe(false);
  });

  // WR-04: a SCHEMALESS (passthrough) endpoint must receive the UNWRAPPED body, not the
  // double-wrapped `{ args: {...} }` envelope the passthrough inputSchema advertises.
  it("unwraps the passthrough envelope so a schemaless endpoint gets the intended body (WR-04)", async () => {
    // A card whose openapi carries NO request schema -> deriveInputShape falls back to the
    // passthrough `{ args }` envelope.
    const schemaless = discoveredCard({ openapi: { openapi: "3.1.0", info: {}, paths: {} } });
    let postedBody: unknown = null;
    const built = buildEndpointTool(schemaless, async (req) => {
      postedBody = req.body;
      return { response: "{}", debitAmount: 1n };
    });
    // The model passes the passthrough envelope `{ args: { city: "Berlin" } }`.
    await built.handler({ args: { city: "Berlin" } });
    // The body POSTed to the seller is the INNER payload, not the wrapper.
    expect(postedBody).toEqual({ city: "Berlin" });
    expect(postedBody).not.toHaveProperty("args");
  });

  it("forwards the validated args directly when the openapi DOES carry a schema (no unwrap)", async () => {
    const card = discoveredCard(); // OPENAPI has a city schema (property-derived shape)
    let postedBody: unknown = null;
    const built = buildEndpointTool(card, async (req) => {
      postedBody = req.body;
      return { response: "{}", debitAmount: 1n };
    });
    await built.handler({ city: "Paris" });
    // The schema-derived case forwards the args object directly (no envelope).
    expect(postedBody).toEqual({ city: "Paris" });
  });
});

describe("buildDiscoveryTool (BUY-02): lists/searches resources projecting price/reputation only", () => {
  it("projects price + reputation + bond, NEVER a key", async () => {
    const tool = buildDiscoveryTool(async () => [discoveredCard()]);
    expect(tool.name).toMatch(/discover|list|search/i);
    const res = await tool.handler({});
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toMatch(/Weather/);
    expect(text).toMatch(/USDC|10000/);
    expect(text).toMatch(/verified|42/);
    expect(text.toLowerCase()).not.toContain("privatekey");
  });
});

describe("createMcpServer (BUY-02/BUY-03): registration + handler->pay + key hygiene + budget", () => {
  let paidWith: { resourceId: string; body: unknown } | null;
  let payCalls: number;

  function fixtureClient() {
    return {
      async pay(req: { resource: { resourceId: string }; body: unknown }) {
        payCalls += 1;
        paidWith = { resourceId: req.resource.resourceId, body: req.body };
        return {
          paid: true,
          status: 200,
          response: JSON.stringify({ echo: "ok" }),
          debitAmount: 8000n,
          cap: 10_000n,
          idemKey: `0x${"ab".repeat(32)}`,
          receipt: { amount: "8000" },
          cardInputs: {},
        };
      },
    };
  }

  beforeEach(() => {
    paidWith = null;
    payCalls = 0;
  });

  it("registers a discovery tool + per-endpoint tools (BUY-02)", async () => {
    const { toolNames } = await createMcpServerAsync({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget: createBudgetGuard({}),
    });
    expect(toolNames.some((n) => /discover|list|search/i.test(n))).toBe(true);
    expect(toolNames.some((n) => /utter_call|utter/i.test(n))).toBe(true);
    expect(toolNames.length).toBeGreaterThanOrEqual(2);
  });

  it("a tool call runs client.pay and returns the validated result (handler->pay wiring)", async () => {
    const { invoke, toolNames } = await createMcpServerAsync({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget: createBudgetGuard({}),
    });
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    const res = await invoke(endpointTool, { city: "Berlin" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("echo");
    expect(payCalls).toBe(1);
    expect(paidWith!.resourceId).toBe(RESOURCE);
    expect((paidWith!.body as { city?: string }).city).toBe("Berlin");
  });

  it("the buyer key NEVER appears in a tool arg or return value (T-07-KEYLEAK)", async () => {
    const { invoke, toolNames } = await createMcpServerAsync({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget: createBudgetGuard({}),
    });
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    const res = await invoke(endpointTool, { city: "Paris" });
    const serial = JSON.stringify(res);
    expect(serial.toLowerCase()).not.toContain("privatekey");
    expect(serial).not.toContain("BUYER_PRIVATE_KEY");
    // The args the model supplied carry no key field either.
    expect(paidWith!.body).not.toHaveProperty("buyerWallet");
  });

  it("a budget-EXCEEDED call returns a tool error and does NOT pay (T-07-DENIALOFWALLET)", async () => {
    const budget = createBudgetGuard({ perToolCapBaseUnits: 5000n }); // < the 10000 cap
    const { invoke, toolNames } = await createMcpServerAsync({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget,
    });
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    const res = await invoke(endpointTool, { city: "London" });
    expect(res.isError).toBe(true);
    expect(payCalls).toBe(0); // budget guard ran BEFORE pay
    const serial = JSON.stringify(res);
    expect(serial.toLowerCase()).not.toContain("privatekey");
  });

  it("the openapi-derived inputSchema REJECTS a malformed arg BEFORE pay (V5)", async () => {
    const { invoke, toolNames } = await createMcpServerAsync({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget: createBudgetGuard({}),
    });
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    const res = await invoke(endpointTool, { notCity: 1 });
    expect(res.isError).toBe(true);
    expect(payCalls).toBe(0);
  });

  it("createMcpServer (sync, lazy snapshot) also registers + invokes the endpoint tool", async () => {
    const { invoke } = createMcpServer({
      client: fixtureClient(),
      cardSource: async () => [discoveredCard()],
      budget: createBudgetGuard({}),
    });
    // invoke awaits the lazy snapshot internally before dispatching. The tool name is the
    // full-resourceId derivation (WR-01), so derive it rather than hardcoding a prefix.
    const res = await invoke(endpointToolName(discoveredCard()), { city: "Rome" });
    expect(res.isError).toBeFalsy();
    expect(payCalls).toBe(1);
  });

  // WR-02: N PARALLEL tool invocations against a per-day cap that admits fewer must NOT
  // collectively exceed the cap. With reserve-before-pay, the reservations are placed
  // BEFORE the (slow) pay resolves, so the excess calls are denied at the gate and never
  // pay - the old check-then-pay-then-record path would let all N through.
  it("N parallel tool calls never collectively exceed the per-day cap (WR-02)", async () => {
    // A slow client: pay yields (so all invocations reach the reserve gate before any
    // commit), then settles 8000 base units. The card cap is 10_000.
    const slowClient = {
      async pay(req: { resource: { resourceId: string }; body: unknown }) {
        payCalls += 1;
        void req;
        await new Promise((r) => setTimeout(r, 5));
        return {
          paid: true,
          status: 200,
          response: JSON.stringify({ echo: "ok" }),
          debitAmount: 8000n,
          cap: 10_000n,
          idemKey: `0x${"ab".repeat(32)}`,
          receipt: { amount: "8000" },
          cardInputs: {},
        };
      },
    };
    // The cap reserves against the CARD cap (10_000) per call; a 25_000 day cap admits 2
    // reservations (2*10_000=20_000 <= 25_000) and denies the 3rd (30_000 > 25_000).
    const budget = createBudgetGuard({ perDayCapBaseUnits: 25_000n });
    const { invoke, toolNames } = await createMcpServerAsync({
      client: slowClient,
      cardSource: async () => [discoveredCard()],
      budget,
    });
    const endpointTool = toolNames.find((n) => /utter_call/i.test(n))!;
    // Fire 4 in parallel against a cap that admits only 2.
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => invoke(endpointTool, { city: "Berlin" })),
    );
    const ok = results.filter((r) => !r.isError);
    const denied = results.filter((r) => r.isError);
    expect(ok.length).toBe(2); // only 2 admitted
    expect(denied.length).toBe(2); // the excess 2 denied at the reserve gate
    expect(payCalls).toBe(2); // the denied calls NEVER paid
    // The committed spend (2 * 8000 metered) is within the cap.
    expect(budget.spentForDay()).toBe(16_000n);
    expect(budget.spentForDay() <= 25_000n).toBe(true);
  });
});

describe("stdout-clean + key-hygiene grep (Pitfall 1 / T-07-STDOUT / T-07-KEYLEAK)", () => {
  const files = [
    "mcp/budget.ts",
    "mcp/tools.ts",
    "mcp/server.ts",
    "bin/mcp.ts",
  ];
  it("src/mcp + src/bin carry ZERO console.log (stdout is the JSON-RPC channel)", () => {
    for (const f of files) {
      const text = readFileSync(resolve(SRC, f), "utf8");
      // Strip line comments so a doc-reference to console.log does not trip the grep.
      const code = text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      expect(code, `${f} must not write to stdout`).not.toMatch(/console\s*\.\s*log\s*\(/);
    }
  });

  it("src/mcp + src/bin never reference the BUYER_PRIVATE_KEY value in a return/log path", () => {
    // The bin may READ process.env.BUYER_PRIVATE_KEY into the wallet once; assert no file
    // logs it. We grep for any console.* call on the same line as the key env name.
    for (const f of files) {
      const text = readFileSync(resolve(SRC, f), "utf8");
      for (const line of text.split("\n")) {
        if (/console\s*\./.test(line)) {
          expect(line, `${f}: no key in a log line`).not.toContain("BUYER_PRIVATE_KEY");
        }
      }
    }
  });
});
