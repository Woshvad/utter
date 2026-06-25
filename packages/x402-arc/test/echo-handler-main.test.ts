// echo-handler-main.test.ts - the GATE-LESS echo handler entrypoint (wave BC1).
//
// Proves the untrusted handler container in the sidecar topology serves /echo + /call
// via the trusted echoHandler with NO payment gate and NO facilitator interaction, and
// serves a discovery agent card whose x402.payTo is the deploy-final resourceId.
//
// The handler holds no facilitator config and no token: a plain POST runs the handler
// directly (no 402, no /verify), success returns {echo,length}, a non-string text is
// the declared 400 error. loadHandlerConfig fails fast on missing required vars and
// maps the public pricing terms.
import { describe, it, expect } from "vitest";
import {
  buildHandlerApp,
  loadHandlerConfig,
  buildHandlerAgentCard,
} from "../examples/echo/handler-main";

const RID = `0x${"ab".repeat(32)}` as const;

/** Build a config the way the entrypoint would, without reading process.env. */
function cfg() {
  return {
    port: 8080,
    resourceId: RID,
    cap: 1_000_000n,
    pricing: { model: "metered", base: "1000", perKB: "0", computeMultiplier: "0" } as const,
    maxTimeoutSeconds: 30,
  };
}

describe("buildHandlerApp (gate-less: no 402, no facilitator)", () => {
  it("returns 200 {echo,length} for a valid POST /echo - NO 402, handler runs directly", async () => {
    const app = buildHandlerApp(cfg());
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    // No gate: a plain unpaid POST is NOT challenged - the handler runs immediately.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(402);
    expect(await res.json()).toEqual({ echo: "hello", length: 5 });
  });

  it("serves /call identically to /echo (the studio route) with NO gate", async () => {
    const app = buildHandlerApp(cfg());
    const res = await app.request("/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: "world", length: 5 });
  });

  it("returns the declared 400 error for a non-string text (buyer bad input)", async () => {
    const app = buildHandlerApp(cfg());
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text must be a string", code: "BAD_INPUT" });
  });

  it("serves the agent card whose x402.payTo === resourceId (free discovery)", async () => {
    const app = buildHandlerApp(cfg());
    const res = await app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = (await res.json()) as Record<string, unknown>;
    const x402 = card.x402 as Record<string, unknown>;
    expect(x402.payTo).toBe(RID);
    expect(x402.scheme).toBe("utter-escrow");
    expect(x402.maxAmountRequired).toBe("1000000");
    // The card carries NO facilitator config (the handler never reaches one).
    expect("facilitatorUrl" in x402).toBe(false);
    expect("facilitatorToken" in card).toBe(false);
  });

  it("buildHandlerAgentCard advertises the public pricing terms", () => {
    const card = buildHandlerAgentCard(cfg());
    const x402 = card.x402 as Record<string, unknown>;
    expect(x402.pricing).toEqual({
      model: "metered",
      base: "1000",
      perKB: "0",
      computeMultiplier: "0",
    });
  });
});

describe("loadHandlerConfig (non-secret discovery config; no facilitator/token)", () => {
  it("fails fast when RESOURCE_ID is missing", () => {
    expect(() => loadHandlerConfig({ CAP: "1000000" })).toThrow(/RESOURCE_ID/);
  });

  it("fails fast when CAP is missing", () => {
    expect(() => loadHandlerConfig({ RESOURCE_ID: RID })).toThrow(/CAP/);
  });

  it("maps PRICE_* terms and defaults PORT/MAX_TIMEOUT_SECONDS", () => {
    const out = loadHandlerConfig({
      RESOURCE_ID: RID,
      CAP: "2000000",
      PRICE_BASE: "500",
      PRICE_PER_KB: "10",
      PRICE_MAX: "99",
    });
    expect(out.port).toBe(8080);
    expect(out.maxTimeoutSeconds).toBe(30);
    expect(out.cap).toBe(2_000_000n);
    expect(out.pricing).toEqual({
      model: "metered",
      base: "500",
      perKB: "10",
      computeMultiplier: "99",
    });
  });

  it("does NOT read FACILITATOR_URL (the handler holds no facilitator config)", () => {
    // Even with FACILITATOR_URL set, the config carries no facilitatorUrl field.
    const out = loadHandlerConfig({ RESOURCE_ID: RID, CAP: "1", FACILITATOR_URL: "http://x" });
    expect("facilitatorUrl" in out).toBe(false);
  });
});
