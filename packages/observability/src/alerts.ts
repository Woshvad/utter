// alerts.ts - the OBS-02 pure threshold evaluators + injectable AlertSink.
//
// evaluateAlerts mirrors packages/ai-scorer/src/strikes.ts reduceStrike: a PURE
// deterministic function (input -> output) with NO I/O. It reads a registry
// snapshot + threshold consts and returns one typed Alert per breached threshold;
// it neither emits, fetches, nor logs - the schedule/route loop drives the sink
// emit OUTSIDE this function, exactly as reduceStrike returns a transition the loop
// acts on. The thresholds are consts (mirroring STRIKE_LIMIT).
//
// The AlertSink is injectable: the InMemoryAlertSink (mirroring InMemoryQuotaStore)
// is the deterministic test default; selectAlertSink(env) (mirroring selectProber)
// returns it unless ALERT_SINK_URL is configured, in which case it returns the
// operator-gated LiveAlertSink that fail-louds - the live exfil path is NEVER
// reached autonomously (T-06-ALERTSINK).

/** The four OBS-02 alert kinds. */
export type AlertKind =
  | "low_relayer_usdc"
  | "settle_failure_spike"
  | "egress_denial_spike"
  | "scorer_mass_deactivation";

/** A typed alert event emitted to an AlertSink. Carries a non-secret message + detail. */
export interface Alert {
  /** Which threshold breached. */
  kind: AlertKind;
  /** A short, non-secret human-readable message. */
  message: string;
  /** Non-secret numeric context for the breach (e.g. observed rate vs threshold). */
  detail: Record<string, number | string>;
}

/**
 * A point-in-time snapshot of the registry counters the alert evaluators read. The
 * relayer balance is in BASE UNITS (bigint) - the low-relayer threshold compares
 * base units directly, so there is no decimals literal in the comparison.
 */
export interface MetricSnapshot {
  /** Relayer wallet USDC balance in base units (bigint - no decimals applied here). */
  relayerUsdcBaseUnits: bigint;
  /** Total settle attempts in the window. */
  settleAttempts: number;
  /** Settle failures in the window. */
  settleFailures: number;
  /** Total egress (proxy) attempts in the window. */
  egressAttempts: number;
  /** Egress denials (default-deny firewall blocks) in the window. */
  egressDenials: number;
  /** Currently-active resources. */
  activeResources: number;
  /** Resources deactivated in the window (scorer strikes). */
  deactivatedResources: number;
}

/**
 * The alert thresholds. Consts mirroring STRIKE_LIMIT in strikes.ts. Rates are
 * fractions in [0,1]; the relayer floor is in BASE UNITS (bigint), so the
 * comparison stays in base units with no decimals literal.
 */
export interface AlertThresholds {
  /** Fire low_relayer_usdc when relayer base units fall below this floor. */
  relayerFloorBaseUnits: bigint;
  /** Fire settle_failure_spike when failures/attempts exceeds this fraction. */
  settleFailureRate: number;
  /** Fire egress_denial_spike when denials/attempts exceeds this fraction. */
  egressDenialRate: number;
  /** Fire scorer_mass_deactivation when deactivated/(active+deactivated) exceeds this. */
  massDeactivationRate: number;
}

/**
 * Default thresholds. The relayer floor is a conservative base-unit value (it is NOT
 * a USDC-amount math path - it is a raw base-unit comparison, so no decimals literal
 * applies). The operator may tune these; they are deliberately explicit consts.
 */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  relayerFloorBaseUnits: 10n, // a deliberately tiny floor; operator tunes per relayer policy
  settleFailureRate: 0.2,
  egressDenialRate: 0.5,
  massDeactivationRate: 0.3,
};

/** Safe ratio: 0 when there are no attempts (avoids a divide-by-zero false spike). */
function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Pure threshold evaluator. Given a registry snapshot and thresholds, returns one
 * typed Alert per breached threshold. NO I/O - mirrors reduceStrike: it describes
 * what breached; the caller emits to the sink. Deterministic: same input -> same
 * output.
 */
export function evaluateAlerts(
  snapshot: MetricSnapshot,
  thresholds: AlertThresholds,
): Alert[] {
  const alerts: Alert[] = [];

  // Low relayer USDC - base-unit comparison, no decimals literal (T-06-DECIMALS).
  if (snapshot.relayerUsdcBaseUnits < thresholds.relayerFloorBaseUnits) {
    alerts.push({
      kind: "low_relayer_usdc",
      message: "relayer USDC balance below floor",
      detail: {
        relayerBaseUnits: snapshot.relayerUsdcBaseUnits.toString(),
        floorBaseUnits: thresholds.relayerFloorBaseUnits.toString(),
      },
    });
  }

  // Settle-failure-rate spike.
  const settleRate = rate(snapshot.settleFailures, snapshot.settleAttempts);
  if (settleRate > thresholds.settleFailureRate) {
    alerts.push({
      kind: "settle_failure_spike",
      message: "settle failure rate above threshold",
      detail: { observed: settleRate, threshold: thresholds.settleFailureRate },
    });
  }

  // Egress-denial-rate spike.
  const denialRate = rate(snapshot.egressDenials, snapshot.egressAttempts);
  if (denialRate > thresholds.egressDenialRate) {
    alerts.push({
      kind: "egress_denial_spike",
      message: "egress denial rate above threshold",
      detail: { observed: denialRate, threshold: thresholds.egressDenialRate },
    });
  }

  // Scorer mass-deactivation.
  const totalResources = snapshot.activeResources + snapshot.deactivatedResources;
  const deactivationRate = rate(snapshot.deactivatedResources, totalResources);
  if (deactivationRate > thresholds.massDeactivationRate) {
    alerts.push({
      kind: "scorer_mass_deactivation",
      message: "deactivated resource fraction above threshold",
      detail: { observed: deactivationRate, threshold: thresholds.massDeactivationRate },
    });
  }

  return alerts;
}

/** The sink alerts are emitted to. Injectable so the live exfil path is gated. */
export interface AlertSink {
  emit(alert: Alert): void;
}

/**
 * In-memory AlertSink (test default - mirrors InMemoryQuotaStore). Collects emitted
 * alerts for assertions; the autonomous suite never reaches a network sink.
 */
export class InMemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  emit(alert: Alert): void {
    this.alerts.push(alert);
  }
}

/** Thrown by the operator-gated live sink when it is selected but not implemented. */
export class RequiresAlertSinkConfigError extends Error {
  constructor() {
    super(
      "LiveAlertSink requires the operator-provisioned alert ingest endpoint " +
        "(ALERT_SINK_URL). Shipping alerts to an external sink is operator-gated; " +
        "it is NOT autonomous.",
    );
    this.name = "RequiresAlertSinkConfigError";
  }
}

/**
 * The operator-gated live AlertSink stub. It is NEVER reached autonomously: emit
 * throws RequiresAlertSinkConfigError so the suite cannot mistake it for a live
 * ship. The real implementation POSTs the alert to ALERT_SINK_URL; it is wired in a
 * later operator-gated plan (T-06-ALERTSINK).
 */
export class LiveAlertSink implements AlertSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_alert: Alert): void {
    throw new RequiresAlertSinkConfigError();
  }
}

/**
 * Env-driven sink selection (mirrors selectProber in ai-scorer/src/prober.ts).
 * Defaults to the InMemoryAlertSink whenever ALERT_SINK_URL is unset/empty - so the
 * autonomous suite never reaches a network path. Returns the operator-gated
 * LiveAlertSink only when ALERT_SINK_URL is configured.
 */
export function selectAlertSink(env: NodeJS.ProcessEnv = process.env): AlertSink {
  if (!env.ALERT_SINK_URL) {
    return new InMemoryAlertSink();
  }
  return new LiveAlertSink();
}
