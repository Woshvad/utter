// recover-resources.test.ts - the PURE recovery helpers (no docker, no network).
//
// Proves the resource facts + the finalized card are correctly reconstructed from a
// running sidecar's env, which is the load-bearing part of the recovery: the card must
// finalize its payTo to the resourceId (the marketplace publish gate) and the pricing
// must round-trip back to the identical sidecar env when the sidecar is relaunched.
import { describe, it, expect } from "vitest";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import { buildSidecarServiceEnv } from "../src/orchestrate";
import {
  parseEnvArray,
  parseSidecarEnv,
  deslugToPrompt,
  buildRecoveredCard,
} from "../src/recover-resources";

const RESOURCE_ID = `0x${"ab".repeat(32)}` as `0x${string}`;
const OTHER_ID = `0x${"cd".repeat(32)}` as `0x${string}`;

describe("parseEnvArray", () => {
  it("splits on the FIRST '=' so JSON values (which contain '=') survive intact", () => {
    const json = '{"a":"b=c","d":"e"}';
    const map = parseEnvArray(["RESOURCE_ID=0x1", `CLASSIFIER_SCHEMA=${json}`, "PORT=8080"]);
    expect(map.RESOURCE_ID).toBe("0x1");
    expect(map.CLASSIFIER_SCHEMA).toBe(json);
    expect(map.PORT).toBe("8080");
  });

  it("skips malformed entries and returns an empty map for undefined", () => {
    expect(parseEnvArray(undefined)).toEqual({});
    const map = parseEnvArray(["=novalue", "NOEQUALS", "K=v"]);
    expect(map).toEqual({ K: "v" });
  });
});

describe("deslugToPrompt", () => {
  it("turns a slug back into a readable prompt", () => {
    expect(deslugToPrompt("score-the-sentiment-of-a-tweet")).toBe("score the sentiment of a tweet");
    expect(deslugToPrompt("")).toBe("resource");
    expect(deslugToPrompt("---")).toBe("resource");
  });
});

describe("parseSidecarEnv", () => {
  // A representative sidecar env produced by buildSidecarServiceEnv (the deploy path).
  const pricing = { model: "metered" as const, base: "5000", perKB: "100", computeMultiplier: "200", maxResponseBytes: 1048576 };
  const fullEnv = buildSidecarServiceEnv({
    facilitatorUrl: "http://10.0.0.5:8787",
    resourceId: RESOURCE_ID,
    cap: 10000n,
    pricing,
    maxTimeoutSeconds: 30,
    handlerUrl: "http://10.0.0.6:8080",
    facilitatorToken: "tok-never-read-here",
    classifierSchema: '{"openapi":"3.1.0","paths":{}}',
    freePaths: ["/.well-known/agent-card.json"],
    agentCard: '{"name":"x"}',
    port: 8080,
  });

  it("inverts buildSidecarServiceEnv: pricing/cap/timeout/freePaths/card round-trip", () => {
    const r = parseSidecarEnv(fullEnv);
    expect(r.resourceId).toBe(RESOURCE_ID);
    expect(r.cap).toBe(10000n);
    expect(r.maxTimeoutSeconds).toBe(30);
    expect(r.pricing.base).toBe("5000");
    expect(r.pricing.perKB).toBe("100");
    // PRICE_MAX <- computeMultiplier is inverted back to computeMultiplier.
    expect(r.pricing.computeMultiplier).toBe("200");
    expect(r.pricing.maxResponseBytes).toBe(1048576);
    expect(r.classifierSchema).toBe('{"openapi":"3.1.0","paths":{}}');
    expect(r.freePaths).toEqual(["/.well-known/agent-card.json"]);
    expect(r.agentCardJson).toBe('{"name":"x"}');
  });

  it("re-emits the identical PRICE_* env when the recovered pricing is passed back", () => {
    const r = parseSidecarEnv(fullEnv);
    const reEmitted = buildSidecarServiceEnv({
      facilitatorUrl: "http://10.0.0.5:8787",
      resourceId: r.resourceId,
      cap: r.cap,
      pricing: r.pricing,
      maxTimeoutSeconds: r.maxTimeoutSeconds,
      handlerUrl: "http://10.0.0.6:8080",
      facilitatorToken: "tok",
      classifierSchema: r.classifierSchema,
      freePaths: r.freePaths,
      port: 8080,
    });
    expect(reEmitted.PRICE_BASE).toBe(fullEnv.PRICE_BASE);
    expect(reEmitted.PRICE_PER_KB).toBe(fullEnv.PRICE_PER_KB);
    expect(reEmitted.PRICE_MAX).toBe(fullEnv.PRICE_MAX);
    expect(reEmitted.CAP).toBe(fullEnv.CAP);
    expect(reEmitted.MAX_RESPONSE_BYTES).toBe(fullEnv.MAX_RESPONSE_BYTES);
    expect(reEmitted.FREE_PATHS).toBe(fullEnv.FREE_PATHS);
  });

  it("defaults freePaths to the agent-card route and omits agentCardJson when absent", () => {
    const env = { ...fullEnv };
    delete env.FREE_PATHS;
    delete env.AGENT_CARD_JSON;
    const r = parseSidecarEnv(env);
    expect(r.freePaths).toEqual(["/.well-known/agent-card.json"]);
    expect(r.agentCardJson).toBeUndefined();
  });

  it("throws a value-free error naming every missing required key", () => {
    expect(() => parseSidecarEnv({})).toThrowError(/RESOURCE_ID/);
    expect(() => parseSidecarEnv({ RESOURCE_ID: "0x1" } as Record<string, string>)).toThrowError(
      /CAP/,
    );
  });
});

describe("buildRecoveredCard", () => {
  const base = {
    resourceId: RESOURCE_ID,
    cap: 10000n,
    pricing: { model: "metered" as const, base: "5000", perKB: "100", computeMultiplier: "200" },
    maxTimeoutSeconds: 30,
    classifierSchema: "{}",
    freePaths: ["/.well-known/agent-card.json"],
  };

  it("RECONSTRUCTS a card from the slug + pricing and finalizes payTo to the resourceId", () => {
    const out = buildRecoveredCard({ resource: base, slug: "convert-any-currency-to-ngn", domain: "utter.technology" });
    expect(out.fromServedCard).toBe(false);
    expect(out.cardUrl).toBe("https://convert-any-currency-to-ngn.resources.utter.technology/.well-known/agent-card.json");
    const card = JSON.parse(out.finalizedJson) as Record<string, unknown>;
    const x402 = card.x402 as Record<string, unknown>;
    // The load-bearing property: the marketplace payTo-binding gate needs payTo == resourceId.
    expect(x402.payTo).toBe(RESOURCE_ID);
    // The x402 asset/escrow come from @utter/chain (buildAgentCard imports them, never literal).
    expect(x402.asset).toBe(USDC);
    expect(x402.escrow).toBe(PAYMENT_ESCROW);
    // url is stamped to the resource base; the description reads back from the slug.
    expect(card.url).toBe("https://convert-any-currency-to-ngn.resources.utter.technology");
    expect(card.description).toBe("convert any currency to ngn");
  });

  it("FINALIZES a served card (fixing a placeholder/wrong payTo) without rebuilding it", () => {
    // A previously-served card whose payTo points at the WRONG resource (placeholder era).
    const served = JSON.stringify({
      protocolVersion: "0.3.0",
      name: "held",
      description: "an already-served card",
      url: "https://held.resources.example",
      version: "1.0.0",
      capabilities: { streaming: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ id: "held", name: "held", description: "held" }],
      x402: {
        scheme: "utter-escrow",
        network: "eip155:5042002",
        chainId: 5042002,
        asset: USDC,
        escrow: PAYMENT_ESCROW,
        pricing: { model: "metered", base: "1", perKB: "2", max: "3" },
        payTo: OTHER_ID, // WRONG - must be stamped to RESOURCE_ID by finalize.
      },
    });
    const out = buildRecoveredCard({
      resource: { ...base, agentCardJson: served },
      slug: "held",
      domain: "utter.technology",
    });
    expect(out.fromServedCard).toBe(true);
    const card = JSON.parse(out.finalizedJson) as Record<string, unknown>;
    const x402 = card.x402 as Record<string, unknown>;
    expect(x402.payTo).toBe(RESOURCE_ID); // rebound to THIS resource.
    // The served card's own pricing is preserved (not overwritten by reconstruction).
    expect((x402.pricing as Record<string, unknown>).base).toBe("1");
    // url is re-stamped to the real resource base.
    expect(card.url).toBe("https://held.resources.utter.technology");
  });
});
