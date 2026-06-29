// probe.test.ts - the three-dimension prober (SCR-01) + the wrongful-strike guard.
//
// Proves: (1) the schema dimension reuses buildClassifier so a malfunction body
// fails the probe while a declared_error body does NOT (the wrongful-strike
// guard, T-05-03-WRONGSTRIKE); (2) latency over the budget fails; (3) the
// correctness replay matches each test-cases case to its expectedClass; and (4)
// selectProber defaults to FixtureProber when no live host/flag is present
// (autonomous default) and the LiveHttpsProber is operator-gated.
import { describe, it, expect } from "vitest";
import {
  probeSchema,
  probeLatency,
  probeCorrectness,
  runProbe,
  type ProbeInput,
} from "../src/probe";
import {
  FixtureProber,
  LiveHttpsProber,
  selectProber,
  type ProbeResult,
  type ProbeFetch,
  type ProbeCardValidator,
} from "../src/prober";

// A minimal openapi doc with the resource-named *Success / *Error component
// schemas the classifier compiles. EchoSuccess = { result:string, length:number };
// EchoError = { error:string, code:string }. buildClassifier validates against these.
const OPENAPI: Record<string, unknown> = {
  openapi: "3.1.0",
  info: { title: "echo", version: "1.0.0" },
  components: {
    schemas: {
      EchoSuccess: {
        type: "object",
        required: ["result", "length"],
        additionalProperties: false,
        properties: { result: { type: "string" }, length: { type: "number" } },
      },
      EchoError: {
        type: "object",
        required: ["error", "code"],
        additionalProperties: false,
        properties: { error: { type: "string" }, code: { type: "string" } },
      },
    },
  },
};

const REFS = {
  successRef: "openapi.json#/components/schemas/EchoSuccess",
  errorRef: "openapi.json#/components/schemas/EchoError",
};

const SUCCESS_BODY = { result: "hello", length: 5 };
const DECLARED_ERROR_BODY = { error: "text must be a string", code: "BAD_INPUT" };
const MALFUNCTION_BODY = { unexpected: "garbage" };

describe("probeSchema (schema dimension reuses buildClassifier)", () => {
  it("classifies a *Success body as success and passes the schema probe", () => {
    const r = probeSchema(OPENAPI, SUCCESS_BODY, REFS);
    expect(r.classification).toBe("success");
    expect(r.schemaOk).toBe(true);
  });

  it("a declared_error body is NOT a schema failure (wrongful-strike guard)", () => {
    const r = probeSchema(OPENAPI, DECLARED_ERROR_BODY, REFS);
    expect(r.classification).toBe("declared_error");
    // The crux of T-05-03-WRONGSTRIKE: bad buyer input must not strike the creator.
    expect(r.schemaOk).toBe(true);
  });

  it("a malfunction body fails the schema probe", () => {
    const r = probeSchema(OPENAPI, MALFUNCTION_BODY, REFS);
    expect(r.classification).toBe("malfunction");
    expect(r.schemaOk).toBe(false);
  });

  it("an unparseable string body is a malfunction", () => {
    const r = probeSchema(OPENAPI, "}{ not json", REFS);
    expect(r.classification).toBe("malfunction");
    expect(r.schemaOk).toBe(false);
  });
});

describe("probeLatency (latency dimension vs a budget)", () => {
  it("passes when latency is within the budget", () => {
    expect(probeLatency(100, 250).latencyOk).toBe(true);
  });

  it("fails when latency exceeds the budget", () => {
    expect(probeLatency(400, 250).latencyOk).toBe(false);
  });

  it("at exactly the budget is OK (inclusive)", () => {
    expect(probeLatency(250, 250).latencyOk).toBe(true);
  });
});

describe("probeCorrectness (replay test-cases.json -> expectedClass)", () => {
  const cases = [
    { label: "ok", response: SUCCESS_BODY, expectedClass: "success" as const },
    {
      label: "bad-input",
      response: DECLARED_ERROR_BODY,
      expectedClass: "declared_error" as const,
    },
  ];

  it("passes when every case classifies to its expectedClass", () => {
    const r = probeCorrectness(OPENAPI, cases, REFS);
    expect(r.correctnessOk).toBe(true);
    expect(r.mismatches).toHaveLength(0);
  });

  it("fails when a case misclassifies, surfacing the mismatch", () => {
    const bad = [
      { label: "regressed", response: MALFUNCTION_BODY, expectedClass: "success" as const },
    ];
    const r = probeCorrectness(OPENAPI, bad, REFS);
    expect(r.correctnessOk).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatchObject({ expected: "success", got: "malfunction" });
  });
});

describe("runProbe (composes the three dimensions into a ProbeResult)", () => {
  const base: ProbeInput = {
    openapi: OPENAPI,
    refs: REFS,
    body: SUCCESS_BODY,
    latencyMs: 80,
    budgetMs: 250,
    testCases: [{ label: "ok", response: SUCCESS_BODY, expectedClass: "success" }],
  };

  it("a healthy resource passes overall", () => {
    const r = runProbe(base);
    expect(r.passed).toBe(true);
    expect(r.schemaOk).toBe(true);
    expect(r.latencyOk).toBe(true);
    expect(r.correctnessOk).toBe(true);
    expect(r.latencyMs).toBe(80);
  });

  it("a declared_error body does NOT fail the probe (wrongful-strike guard)", () => {
    const r = runProbe({ ...base, body: DECLARED_ERROR_BODY });
    expect(r.passed).toBe(true);
    expect(r.schemaOk).toBe(true);
  });

  it("a malfunction body fails the probe with a reason", () => {
    const r = runProbe({ ...base, body: MALFUNCTION_BODY });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/schema/i);
  });

  it("a latency-budget miss fails the probe with a reason", () => {
    const r = runProbe({ ...base, latencyMs: 999 });
    expect(r.passed).toBe(false);
    expect(r.latencyOk).toBe(false);
    expect(r.reason).toMatch(/latency/i);
  });

  it("a correctness regression fails the probe with a reason", () => {
    const r = runProbe({
      ...base,
      testCases: [{ label: "x", response: MALFUNCTION_BODY, expectedClass: "success" }],
    });
    expect(r.passed).toBe(false);
    expect(r.correctnessOk).toBe(false);
    expect(r.reason).toMatch(/correctness/i);
  });
});

describe("FixtureProber (the autonomous test default)", () => {
  it("has the fixture backend discriminator and returns its configured result", async () => {
    const fixture: ProbeResult = {
      passed: true,
      schemaOk: true,
      latencyOk: true,
      correctnessOk: true,
      latencyMs: 42,
    };
    const prober = new FixtureProber(fixture);
    expect(prober.backend).toBe("fixture");
    const r = await prober.probe({ resourceId: "0xabc" });
    expect(r).toEqual(fixture);
  });

  it("supports a per-resource fixture map", async () => {
    const a: ProbeResult = {
      passed: true,
      schemaOk: true,
      latencyOk: true,
      correctnessOk: true,
      latencyMs: 1,
    };
    const b: ProbeResult = {
      passed: false,
      schemaOk: false,
      latencyOk: true,
      correctnessOk: true,
      latencyMs: 2,
      reason: "schema",
    };
    const prober = new FixtureProber({ "0xa": a, "0xb": b });
    expect((await prober.probe({ resourceId: "0xa" })).passed).toBe(true);
    expect((await prober.probe({ resourceId: "0xb" })).passed).toBe(false);
  });
});

describe("LiveHttpsProber (operator-gated no-pay liveness + conformance probe)", () => {
  const CARD_PATH = "/.well-known/agent-card.json";
  const BASE = "https://echo.resources.example";
  const CARD_URL = `${BASE}${CARD_PATH}`;
  const CALL_URL = `${BASE}/call`;

  // A plausible Utter A2A v0.3.0 card the light default validator accepts.
  const VALID_CARD = {
    protocolVersion: "0.3.0",
    name: "echo",
    description: "echo",
    version: "1.0.0",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "echo", name: "echo", description: "echo" }],
    x402: {
      scheme: "utter-escrow",
      network: "eip155:5042002",
      chainId: 5042002,
      asset: "0x3600000000000000000000000000000000000000",
      escrow: "0xescrow",
      pricing: { model: "flat", base: "10000", perKB: "0", max: "10000" },
    },
  };

  /** Build a fake ProbeFetch from a per-URL response map. Records every call. */
  function fakeFetch(routes: Record<string, { status: number; body?: unknown; throws?: boolean }>) {
    const calls: Array<{ url: string; init?: Parameters<ProbeFetch>[1] }> = [];
    const fetcher: ProbeFetch = async (url, init) => {
      calls.push({ url, init });
      const hit = routes[url];
      if (!hit || hit.throws) throw new Error(`fake fetch: no route / forced throw for ${url}`);
      return { status: hit.status, json: async () => hit.body };
    };
    return { fetcher, calls };
  }

  /** A clock that yields the supplied values in order (default delta under budget). */
  function clockOf(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)] ?? 0;
  }

  it("has the live-https backend discriminator", () => {
    expect(new LiveHttpsProber().backend).toBe("live-https");
  });

  it("PASSES when the card is 200+valid and the unpaid /call returns 402 within budget", async () => {
    const { fetcher, calls } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    const prober = new LiveHttpsProber({ fetcher, now: clockOf([1000, 1050]) });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r).toEqual({
      passed: true,
      schemaOk: true,
      latencyOk: true,
      correctnessOk: true,
      latencyMs: 50,
    });
    // GET the normalized card url first, then POST the derived /call url.
    expect(calls[0]).toMatchObject({ url: CARD_URL, init: { method: "GET" } });
    expect(calls[1]).toMatchObject({
      url: CALL_URL,
      init: { method: "POST", headers: { "content-type": "application/json" } },
    });
  });

  it("normalizes a base url (no card path) by appending the card path", async () => {
    const { fetcher, calls } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    const prober = new LiveHttpsProber({ fetcher, now: clockOf([0, 10]) });
    const r = await prober.probe({ resourceId: "0xabc", url: BASE });
    expect(r.passed).toBe(true);
    expect(calls[0]?.url).toBe(CARD_URL);
    expect(calls[1]?.url).toBe(CALL_URL);
  });

  it("fails (schemaOk:false) when the card is not served (status 500)", async () => {
    const { fetcher } = fakeFetch({ [CARD_URL]: { status: 500 } });
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/card not served/i);
  });

  it("fails (schemaOk:false) when the card fetch throws", async () => {
    const { fetcher } = fakeFetch({ [CARD_URL]: { status: 200, throws: true } });
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/card fetch failed/i);
  });

  it("fails (schemaOk:false) when the served card is invalid (no x402 / wrong scheme)", async () => {
    const bad = { ...VALID_CARD, x402: { ...VALID_CARD.x402, scheme: "exact" } };
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: bad },
      [CALL_URL]: { status: 402 },
    });
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/invalid card/i);
  });

  it("fails (correctnessOk:false) when the unpaid /call leaks a 200 (free-serve money leak)", async () => {
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 200 },
    });
    const prober = new LiveHttpsProber({ fetcher, now: clockOf([0, 5]) });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(true);
    expect(r.correctnessOk).toBe(false);
    expect(r.reason).toMatch(/pay gate not enforced/i);
  });

  it("fails (correctnessOk:false) when the unpaid /call returns a 500", async () => {
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 500 },
    });
    const prober = new LiveHttpsProber({ fetcher, now: clockOf([0, 5]) });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(true);
    expect(r.correctnessOk).toBe(false);
  });

  it("fails (correctnessOk:false) when the unpaid /call is unreachable", async () => {
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 0, throws: true },
    });
    const prober = new LiveHttpsProber({ fetcher, now: clockOf([0, 5]) });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(true);
    expect(r.correctnessOk).toBe(false);
    expect(r.reason).toMatch(/\/call unreachable/i);
  });

  it("fails (latencyOk:false) when the /call round-trip exceeds the budget", async () => {
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    // /call still 402 (correctnessOk:true) but the clock advances 99999ms.
    const prober = new LiveHttpsProber({
      fetcher,
      budgetMs: 1000,
      now: clockOf([0, 99999]),
    });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.correctnessOk).toBe(true);
    expect(r.latencyOk).toBe(false);
    expect(r.latencyMs).toBe(99999);
    expect(r.reason).toMatch(/latency/i);
  });

  it("fails on a non-https url (minimal SSRF guard)", async () => {
    const { fetcher, calls } = fakeFetch({});
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({ resourceId: "0xabc", url: "http://echo.resources.example" });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/non-https/i);
    // No fetch happened (guarded before any network).
    expect(calls).toHaveLength(0);
  });

  it("fails when no target url is supplied", async () => {
    const { fetcher } = fakeFetch({});
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({ resourceId: "0xabc" });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/no target url/i);
  });

  it("honors an injected validateCard seam (proves the seam)", async () => {
    const rejectAll: ProbeCardValidator = () => ({ valid: false, errors: ["seam rejected"] });
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    const prober = new LiveHttpsProber({ fetcher, validateCard: rejectAll });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/seam rejected/i);
  });

  it("returns a failed result (never throws) when an injected validateCard throws", async () => {
    const boom: ProbeCardValidator = () => {
      throw new Error("validator boom");
    };
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    const prober = new LiveHttpsProber({ fetcher, validateCard: boom });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(false);
    expect(r.schemaOk).toBe(false);
    expect(r.reason).toMatch(/validator threw/i);
  });

  it("rejects a credentialed url before any fetch (SSRF guard)", async () => {
    const { fetcher, calls } = fakeFetch({});
    const prober = new LiveHttpsProber({ fetcher });
    const r = await prober.probe({
      resourceId: "0xabc",
      url: "https://user@echo.resources.example/.well-known/agent-card.json",
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/credentialed/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a host outside the operator's allowed domain before any fetch (SSRF bind)", async () => {
    const { fetcher, calls } = fakeFetch({});
    const prober = new LiveHttpsProber({ fetcher, allowedHost: "resources.example" });
    const r = await prober.probe({
      resourceId: "0xabc",
      url: "https://169.254.169.254/.well-known/agent-card.json",
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/not under allowed domain/i);
    expect(calls).toHaveLength(0);
  });

  it("allows a host under the operator's allowed domain (incl. a *. wildcard form)", async () => {
    const { fetcher } = fakeFetch({
      [CARD_URL]: { status: 200, body: VALID_CARD },
      [CALL_URL]: { status: 402 },
    });
    // BASE host is echo.resources.example; the wildcard form normalizes to resources.example.
    const prober = new LiveHttpsProber({
      fetcher,
      allowedHost: "*.resources.example",
      now: clockOf([0, 5]),
    });
    const r = await prober.probe({ resourceId: "0xabc", url: CARD_URL });
    expect(r.passed).toBe(true);
  });
});

describe("selectProber (env-driven, mirrors selectGenerator)", () => {
  it("defaults to FixtureProber when no live host/flag is present", () => {
    expect(selectProber({}).backend).toBe("fixture");
  });

  it("stays on FixtureProber when the prober is explicitly forced to fixture", () => {
    expect(
      selectProber({ SCORER_PROBER: "fixture", SCORER_LIVE_HTTPS_HOST: "x.resources.example" })
        .backend,
    ).toBe("fixture");
  });

  it("selects LiveHttpsProber only when the live host is set and not forced to fixture", () => {
    expect(selectProber({ SCORER_LIVE_HTTPS_HOST: "x.resources.example" }).backend).toBe(
      "live-https",
    );
  });
});
