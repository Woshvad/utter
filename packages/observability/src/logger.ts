// logger.ts - the OBS-02 structured JSON logger.
//
// Every log line is keyed by `resourceId` + `idemKey` (the two OBS-02 keys) and
// carries exactly one money-path event (verify/reserve/settle/release/strike/
// refund). The logger follows the CLAUDE.md / 06-RESEARCH V7 secret-redaction
// discipline: a field ALLOWLIST gates the output. Only the allowlisted operational
// fields pass through verbatim; any field carrying secret material (SESSION_SECRET,
// raw API keys, signatures, private keys, bearer tokens) is replaced with the
// REDACTED marker BEFORE serialization - the raw value never reaches the output
// (T-06-LOGLEAK). The logger writes through an injectable Sink, so this module
// deliberately makes no direct stdout/stderr logging call: the in-process
// CaptureSink is the test default and the operator wires a real sink in the live
// path.

/** The replacement written in place of any redacted secret value. */
export const REDACTED = "[REDACTED]" as const;

/** The money-path events one log line may describe (one event per line). */
export type MoneyPathEvent =
  | "verify"
  | "reserve"
  | "settle"
  | "release"
  | "strike"
  | "refund";

/** A log record: the two OBS-02 keys + the event + arbitrary operational fields. */
export interface LogRecord {
  /** The resource this line is about (OBS-02 key). */
  resourceId: string;
  /** The payment idempotency key this line is about (OBS-02 key). */
  idemKey: string;
  /** The single money-path event this line describes. */
  event: MoneyPathEvent;
  /** Any additional operational fields (gated by the allowlist on emit). */
  [field: string]: unknown;
}

/**
 * The sink the logger writes serialized lines through. Injectable so the autonomous
 * suite captures lines in memory and the operator wires a real sink (stdout shipper
 * / log service) in the live path - the logger itself makes no direct stdout call.
 */
export interface LogSink {
  write(line: string): void;
}

/** In-memory sink (test default): collects emitted JSON lines for assertions. */
export class CaptureSink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}

/**
 * The field ALLOWLIST. The structural keys plus the operational, NON-secret fields
 * a money-path line may carry. Anything NOT in this set is redacted on emit - a
 * deny-by-default posture so a newly-introduced secret-bearing field cannot leak by
 * omission. Extend this list (reviewed) when a genuinely non-secret field is added.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  // structural keys (always present)
  "resourceId",
  "idemKey",
  "event",
  // non-secret operational fields
  "amountBaseUnits",
  "decimals",
  "latencyMs",
  "ok",
  "status",
  "reason",
  "schemeKind",
  "buyer",
  "creator",
  "timestamp",
]);

/**
 * The OBS-02 structured logger. `log(record)` serializes one redacted JSON line and
 * writes it through the injected sink. Redaction is allowlist-driven: any field not
 * in ALLOWED_FIELDS is replaced with REDACTED before serialization, so secret
 * material (sessionSecret, rawApiKey, signature, privateKey, bearerToken, ...)
 * never reaches the output even if a caller passes it by mistake (T-06-LOGLEAK).
 */
export class StructuredLogger {
  private readonly sink: LogSink;

  constructor(sink: LogSink) {
    this.sink = sink;
  }

  log(record: LogRecord): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      safe[key] = ALLOWED_FIELDS.has(key) ? value : REDACTED;
    }
    this.sink.write(JSON.stringify(safe));
  }
}
