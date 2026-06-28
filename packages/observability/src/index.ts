// @utter/observability - the OBS-01/02 home (metric registry, structured logger,
// alert evaluators).
//
// USDC gauges store BASE UNITS only; the decimals format is applied at render time
// from a runtime decimals() read - never a literal in the math path (T-06-DECIMALS).
// The structured logger redacts secret material via a deny-by-default field
// allowlist (T-06-LOGLEAK). evaluateAlerts is a pure threshold evaluator; the live
// alert sink and live chain-balance gauges are operator-gated (Pitfall 8).

// OBS-01: dependency-free metric registry (Counter/Gauge/Histogram + Prometheus text)
export {
  Counter,
  Gauge,
  Histogram,
  UsdcGauge,
  Registry,
  renderPrometheus,
  OBS_METRIC_NAMES,
  type HistogramBucket,
  type Renderable,
} from "./registry";

// OBS-02: structured JSON logger keyed by resourceId + idemKey with redaction allowlist
export {
  StructuredLogger,
  CaptureSink,
  REDACTED,
  type LogRecord,
  type LogSink,
  type MoneyPathEvent,
} from "./logger";

// OBS-02: pure threshold evaluators + injectable AlertSink (live sink operator-gated)
export {
  evaluateAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  InMemoryAlertSink,
  LiveAlertSink,
  selectAlertSink,
  RequiresAlertSinkConfigError,
  type Alert,
  type AlertKind,
  type AlertSink,
  type AlertThresholds,
  type MetricSnapshot,
} from "./alerts";

// Provisioning track: the dependency-free graceful-shutdown sequencer (strict drain
// order: stop intake -> drain -> stop loop -> close pools/clients -> exit).
export {
  runGracefulShutdown,
  type HttpServerLike,
  type ShutdownLogger,
  type GracefulShutdownOptions,
  type GracefulShutdown,
} from "./shutdown";
