// metrics.test.ts - OBS-01 /metrics resource route tests.
//
// Asserts: (1) the route returns Prometheus exposition text with the correct
// content-type; (2) the rendered text carries the full OBS-01 metric NAME set
// (Registry.render output); (3) no faked live numbers - the operator-gated
// escrow/relayer chain-balance gauges render 0 in the autonomous path, never an
// invented value (Pitfall 8 / T-06-FAKEMETRICS). The test asserts names + format,
// not invented live values.
import { describe, it, expect, beforeAll } from "vitest";
import { OBS_METRIC_NAMES } from "@utter/observability";

// WR-03: /metrics is now gated by a bearer token (or a creator session). The OBS-01
// content tests authorize with the token; a dedicated test below asserts the 401 path.
const METRICS_TOKEN = "test-metrics-bearer-token-not-for-prod";

beforeAll(() => {
  process.env.METRICS_TOKEN = METRICS_TOKEN;
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
});

/** An authorized GET carrying the operator metrics bearer token. */
function tokenRequest(url = "http://x/metrics"): Request {
  return new Request(url, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
}

describe("/metrics resource route (OBS-01)", () => {
  it("returns Prometheus text with the correct content-type", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = await loader({
      params: {},
      request: tokenRequest(),
      context: {},
    } as never);

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; version=0.0.4");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // Prometheus exposition is one `name value` line per metric, newline-terminated.
    expect(body.endsWith("\n")).toBe(true);
  });

  it("renders the full OBS-01 metric name set", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = await loader({
      params: {},
      request: tokenRequest(),
      context: {},
    } as never);
    const body = await res.text();
    const lines = body.trim().split("\n");
    const names = lines.map((l) => l.split(" ")[0]);
    for (const metric of OBS_METRIC_NAMES) {
      expect(names, `missing OBS-01 metric ${metric}`).toContain(metric);
    }
  });

  it("does not fake the operator-gated chain-balance gauges (escrow/relayer render 0)", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = await loader({
      params: {},
      request: tokenRequest(),
      context: {},
    } as never);
    const body = await res.text();
    // escrow_usdc + relayer_usdc are operator-gated; the autonomous path leaves them
    // at 0 base units (rendered "0") - never a plausible-but-invented live number.
    const escrow = body.split("\n").find((l) => l.startsWith("escrow_usdc "));
    const relayer = body.split("\n").find((l) => l.startsWith("relayer_usdc "));
    expect(escrow).toBe("escrow_usdc 0");
    expect(relayer).toBe("relayer_usdc 0");
    // the seeded gross/creator/platform render their fixture values (format exercised)
    expect(body).toContain("gross_usdc 1.28");
    expect(body).toContain("creator_usdc 0.896");
  });
});

// WR-03: the money-path metric set must be fail-closed. These tests fail against the
// pre-fix (ungated) loader and pass after the bearer/session gate is installed.
describe("/metrics access gate (WR-03)", () => {
  it("returns 401 with no token and no session (unauthenticated)", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = (await loader({
      params: {},
      request: new Request("http://x/metrics"),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(401);
    // the body must NOT contain the money-path exposition
    const body = await res.text();
    expect(body).not.toContain("gross_usdc");
  });

  it("returns 401 for a wrong bearer token (constant-time compare, no leak)", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = (await loader({
      params: {},
      request: new Request("http://x/metrics", {
        headers: { Authorization: "Bearer the-wrong-token-entirely" },
      }),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(401);
  });

  it("returns 200 with the correct bearer token", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = (await loader({
      params: {},
      request: tokenRequest(),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("gross_usdc");
  });

  it("authorizes a valid creator session even without a token", async () => {
    const { sessionStorage } = await import("../app/auth/session.server");
    const session = await sessionStorage.getSession();
    session.set("address", "0x1111111111111111111111111111111111111111");
    const cookie = (await sessionStorage.commitSession(session)).split(";")[0]!;

    const { loader } = await import("../app/routes/metrics");
    const res = (await loader({
      params: {},
      request: new Request("http://x/metrics", { headers: { Cookie: cookie } }),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
  });

  it("disables the bearer path when METRICS_TOKEN is empty (empty can never authorize)", async () => {
    const prev = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = "";
    try {
      const { loader } = await import("../app/routes/metrics");
      // present an empty bearer to mimic an empty-env scraper - must still 401
      const res = (await loader({
        params: {},
        request: new Request("http://x/metrics", {
          headers: { Authorization: "Bearer " },
        }),
        context: {},
      } as never)) as Response;
      expect(res.status).toBe(401);
    } finally {
      process.env.METRICS_TOKEN = prev;
    }
  });
});
