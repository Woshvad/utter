// @utter/observability - the OBS-01/02 home (metric registry, structured logger,
// alert evaluators). This is the Wave-0 placeholder barrel; the registry
// (Counter/Gauge/Histogram), the redacted JSON logger, and the pure
// evaluateAlerts reducer + injectable AlertSink land in the OBS feature plans.
//
// USDC gauges store BASE UNITS only; decimals format is applied at render time
// from a runtime decimals() read - never a 1e6/6/18 literal in the math path.
export {};
