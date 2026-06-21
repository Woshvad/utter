// metrics.test.ts - OBS-01 /metrics resource route tests.
//
// Asserts: (1) the route returns Prometheus exposition text with the correct
// content-type; (2) the rendered text carries the full OBS-01 metric NAME set
// (Registry.render output); (3) no faked live numbers - the operator-gated
// escrow/relayer chain-balance gauges render 0 in the autonomous path, never an
// invented value (Pitfall 8 / T-06-FAKEMETRICS). The test asserts names + format,
// not invented live values.
import { describe, it, expect } from "vitest";
import { OBS_METRIC_NAMES } from "@utter/observability";

describe("/metrics resource route (OBS-01)", () => {
  it("returns Prometheus text with the correct content-type", async () => {
    const { loader } = await import("../app/routes/metrics");
    const res = await loader({
      params: {},
      request: new Request("http://x/metrics"),
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
      request: new Request("http://x/metrics"),
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
      request: new Request("http://x/metrics"),
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
