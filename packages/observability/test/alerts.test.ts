// alerts.test.ts - the OBS-02 pure threshold evaluators + injectable AlertSink.
//
// evaluateAlerts(snapshot, thresholds) mirrors reduceStrike: a pure (input)->output
// function, NO I/O, returning one typed Alert per breached threshold (low relayer
// USDC, settle-failure-rate spike, egress-denial spike, scorer mass-deactivation).
// The in-memory AlertSink is the deterministic test default; selectAlertSink(env)
// returns it unless ALERT_SINK_URL is set (operator-gated live sink, fail-loud).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  evaluateAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  InMemoryAlertSink,
  selectAlertSink,
  RequiresAlertSinkConfigError,
  type MetricSnapshot,
} from "../src/alerts";

/** A healthy baseline snapshot - no threshold breached. */
function healthySnapshot(): MetricSnapshot {
  return {
    relayerUsdcBaseUnits: 100_000_000n, // well above the low-relayer floor
    settleAttempts: 100,
    settleFailures: 1, // 1% failure - below spike
    egressAttempts: 100,
    egressDenials: 1, // 1% denial - below spike
    activeResources: 50,
    deactivatedResources: 1, // 2% deactivated - below mass threshold
  };
}

describe("evaluateAlerts (pure, OBS-02 thresholds)", () => {
  it("returns no alerts for a healthy snapshot", () => {
    expect(evaluateAlerts(healthySnapshot(), DEFAULT_ALERT_THRESHOLDS)).toEqual([]);
  });

  it("fires low_relayer_usdc when the relayer balance drops below the floor", () => {
    const snap = { ...healthySnapshot(), relayerUsdcBaseUnits: 1n };
    const alerts = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.kind)).toContain("low_relayer_usdc");
  });

  it("fires settle_failure_spike when the failure rate exceeds the threshold", () => {
    const snap = { ...healthySnapshot(), settleAttempts: 100, settleFailures: 80 };
    const alerts = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.kind)).toContain("settle_failure_spike");
  });

  it("fires egress_denial_spike when the denial rate exceeds the threshold", () => {
    const snap = { ...healthySnapshot(), egressAttempts: 100, egressDenials: 90 };
    const alerts = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.kind)).toContain("egress_denial_spike");
  });

  it("fires scorer_mass_deactivation when the deactivated fraction exceeds the threshold", () => {
    const snap = { ...healthySnapshot(), activeResources: 50, deactivatedResources: 40 };
    const alerts = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.kind)).toContain("scorer_mass_deactivation");
  });

  it("fires multiple alerts when several thresholds breach at once", () => {
    const snap: MetricSnapshot = {
      relayerUsdcBaseUnits: 1n,
      settleAttempts: 100,
      settleFailures: 90,
      egressAttempts: 100,
      egressDenials: 90,
      activeResources: 10,
      deactivatedResources: 90,
    };
    const kinds = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS).map((a) => a.kind).sort();
    expect(kinds).toEqual(
      ["egress_denial_spike", "low_relayer_usdc", "scorer_mass_deactivation", "settle_failure_spike"].sort(),
    );
  });

  it("is deterministic: same input -> same output", () => {
    const snap = healthySnapshot();
    expect(evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS)).toEqual(
      evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS),
    );
  });
});

describe("evaluateAlerts purity (no I/O)", () => {
  it("the evaluateAlerts function body contains no fetch/fs/console", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/alerts.ts", import.meta.url)),
      "utf8",
    );
    // isolate the evaluateAlerts function body
    const start = src.indexOf("export function evaluateAlerts");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).not.toMatch(/\bfetch\s*\(/);
    expect(body).not.toMatch(/\bconsole\s*\./);
    expect(body).not.toMatch(/from\s+["']node:fs["']/);
    expect(body).not.toMatch(/require\s*\(\s*["']fs["']\s*\)/);
  });
});

describe("InMemoryAlertSink", () => {
  it("collects emitted alerts", () => {
    const sink = new InMemoryAlertSink();
    const alerts = evaluateAlerts(
      { ...healthySnapshot(), relayerUsdcBaseUnits: 1n },
      DEFAULT_ALERT_THRESHOLDS,
    );
    for (const a of alerts) sink.emit(a);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0].kind).toBe("low_relayer_usdc");
  });
});

describe("selectAlertSink env gate", () => {
  it("defaults to the in-memory sink when ALERT_SINK_URL is unset", () => {
    expect(selectAlertSink({})).toBeInstanceOf(InMemoryAlertSink);
  });

  it("defaults to the in-memory sink when ALERT_SINK_URL is empty", () => {
    expect(selectAlertSink({ ALERT_SINK_URL: "" })).toBeInstanceOf(InMemoryAlertSink);
  });

  it("returns an operator-gated live sink that fail-louds when ALERT_SINK_URL is set", () => {
    const sink = selectAlertSink({ ALERT_SINK_URL: "https://alerts.example/ingest" });
    expect(sink).not.toBeInstanceOf(InMemoryAlertSink);
    expect(() => sink.emit({ kind: "low_relayer_usdc", message: "x", detail: {} })).toThrow(
      RequiresAlertSinkConfigError,
    );
  });
});
