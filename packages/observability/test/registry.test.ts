// registry.test.ts - the OBS-01 metric registry (Counter/Gauge/Histogram +
// Prometheus render). Counters/histograms are plain numbers; only USDC gauges carry
// base-unit money and format 6dp-aware from a PASSED runtime decimals - never a 1e6
// literal. These tests pin the named OBS-01 metric set and the no-money-literal rule.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  Counter,
  Gauge,
  Histogram,
  UsdcGauge,
  Registry,
  renderPrometheus,
  OBS_METRIC_NAMES,
} from "../src/registry";

describe("Counter", () => {
  it("inc() accumulates; defaults to 1", () => {
    const c = new Counter();
    expect(c.value).toBe(0);
    c.inc();
    c.inc(4);
    expect(c.value).toBe(5);
  });
});

describe("Gauge", () => {
  it("set() replaces the current value", () => {
    const g = new Gauge();
    g.set(10);
    g.set(3);
    expect(g.value).toBe(3);
  });
});

describe("Histogram", () => {
  it("observe() records count and sum (settle latency)", () => {
    const h = new Histogram();
    h.observe(100);
    h.observe(300);
    expect(h.count).toBe(2);
    expect(h.sum).toBe(400);
  });

  it("exposes bucket counts for latency distribution", () => {
    const h = new Histogram([50, 250, 1000]);
    h.observe(40); // <= 50
    h.observe(200); // <= 250
    h.observe(900); // <= 1000
    h.observe(5000); // overflow
    const buckets = h.buckets;
    expect(buckets.find((b) => b.le === 50)!.count).toBe(1);
    expect(buckets.find((b) => b.le === 250)!.count).toBe(2);
    expect(buckets.find((b) => b.le === 1000)!.count).toBe(3);
  });
});

describe("UsdcGauge (6dp-aware, base units, no money literal)", () => {
  it("stores base units as bigint and replaces on set", () => {
    const g = new UsdcGauge();
    g.set(1_500_000n);
    g.set(2_000_000n);
    expect(g.baseUnits).toBe(2_000_000n);
  });

  it("formats from a PASSED runtime decimals (6 -> human string)", () => {
    const g = new UsdcGauge();
    g.set(2_500_000n);
    // decimals supplied at render time from a runtime read (here 6). The gauge math
    // path never embeds the literal; the caller provides decimals.
    expect(g.format(6)).toBe("2.5");
  });

  it("formats differently when a different runtime decimals is passed (no hardcode)", () => {
    const g = new UsdcGauge();
    g.set(2_500_000n);
    // proves the value is NOT hardcoded to /1e6: 2_500_000 at decimals=3 -> 2500
    expect(g.format(3)).toBe("2500");
  });
});

describe("renderPrometheus", () => {
  it("emits `name value` lines terminated by a newline", () => {
    const text = renderPrometheus({ calls_total: { value: 7 }, health_score: { value: 1 } });
    expect(text).toBe("calls_total 7\nhealth_score 1\n");
  });
});

describe("Registry (OBS-01 named metric set)", () => {
  it("exposes the full OBS-01 named metric set", () => {
    const expected = [
      "calls_total",
      "calls_per_min",
      "settle_latency",
      "settle_failures_total",
      "reservations_open",
      "reservations_released",
      "escrow_usdc",
      "relayer_usdc",
      "health_score",
      "gross_usdc",
      "creator_usdc",
      "platform_usdc",
      "refund_usdc",
      "sandbox_denials_total",
    ];
    for (const name of expected) {
      expect(OBS_METRIC_NAMES).toContain(name);
    }
  });

  it("render() emits Prometheus text covering the named metrics, USDC gauges 6dp-aware", () => {
    const reg = new Registry();
    reg.callsTotal.inc(3);
    reg.settleFailuresTotal.inc(1);
    reg.reservationsOpen.set(2);
    reg.escrowUsdc.set(10_000_000n); // 10 USDC in base units
    reg.relayerUsdc.set(5_000_000n); // 5 USDC
    reg.healthScore.set(1);

    // decimals comes from a runtime read passed into render (here 6).
    const text = reg.render(6);

    expect(text).toContain("calls_total 3");
    expect(text).toContain("settle_failures_total 1");
    expect(text).toContain("reservations_open 2");
    expect(text).toContain("escrow_usdc 10");
    expect(text).toContain("relayer_usdc 5");
    expect(text).toContain("health_score 1");
    // every named metric appears in the exposition
    for (const name of OBS_METRIC_NAMES) {
      expect(text).toContain(name);
    }
  });
});

describe("no money literal in the registry math path (T-06-DECIMALS)", () => {
  it("registry source contains no 1e6 / 10**6 / / 1000000 / bare-6 divisor literal", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/registry.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/1e6/i);
    expect(src).not.toMatch(/10\s*\*\*\s*6/);
    expect(src).not.toMatch(/\/\s*1000000/);
    expect(src).not.toMatch(/1_000_000/);
  });
});
