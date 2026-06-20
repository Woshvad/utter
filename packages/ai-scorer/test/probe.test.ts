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
  RequiresProvisionedHostError,
  type ProbeResult,
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

describe("LiveHttpsProber (operator-gated)", () => {
  it("has the live-https backend discriminator", () => {
    expect(new LiveHttpsProber().backend).toBe("live-https");
  });

  it("throws RequiresProvisionedHostError when probed autonomously", async () => {
    await expect(new LiveHttpsProber().probe({ resourceId: "0xabc" })).rejects.toBeInstanceOf(
      RequiresProvisionedHostError,
    );
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
