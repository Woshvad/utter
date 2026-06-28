// jsonlog.ts - a dependency-free JSON-lines logger for the provisioning/ops track.
//
// This is a SEPARATE module from the OBS-02 money-path StructuredLogger (logger.ts).
// That logger is keyed by resourceId + idemKey and enforces a deny-by-default field
// allowlist over money-path events. This one is a plain operational logger: one JSON
// object per line, a level + msg + ts + arbitrary caller-supplied fields, written
// through an injectable sink. It deliberately does NOT auto-redact - the money-path
// logger owns that discipline; callers here must only pass non-secret fields (the
// reconcile loop forwards just the typed ReconcileErrorEvent fields, which never
// carry secret material).
//
// Dependency-free: only process (for the stdout sink) and Date. No third-party import.

/** The four log severities. */
export type Level = "debug" | "info" | "warn" | "error";

/** The sink a JSON-lines logger writes serialized lines through. Injectable. */
export interface JsonLogSink {
  write(line: string): void;
}

/**
 * In-memory sink (test default): collects each emitted line verbatim AND its parsed
 * object so assertions can read fields without re-parsing. One push per emit, so the
 * autonomous suite can assert exactly one line per log call.
 */
export class CaptureJsonSink implements JsonLogSink {
  readonly lines: string[] = [];
  readonly records: Record<string, unknown>[] = [];
  write(line: string): void {
    this.lines.push(line);
    this.records.push(JSON.parse(line) as Record<string, unknown>);
  }
}

/** The default sink: one line to stdout, newline-terminated (JSON lines). */
export const stdoutSink: JsonLogSink = {
  write(line: string): void {
    process.stdout.write(line + "\n");
  },
};

/**
 * JSON.stringify replacer that serializes a bigint as its base-10 string. Plain
 * JSON.stringify THROWS on a bigint, and USDC base-unit fields are bigints, so this
 * keeps base-units loggable without a decimals literal anywhere in the path.
 */
function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * A dependency-free JSON-lines logger. Each level method serializes exactly one JSON
 * object - `{ level, msg, ts, ...base, ...fields }` - and writes it as a single line
 * through the sink. `child(fields)` returns a logger over the SAME sink with the
 * given fields merged into its base, so a component can pin context (service /
 * component) once and have it appear on every subsequent line.
 */
export class JsonLogger {
  private readonly sink: JsonLogSink;
  private readonly base: Record<string, unknown>;

  constructor(sink: JsonLogSink = stdoutSink, base: Record<string, unknown> = {}) {
    this.sink = sink;
    this.base = base;
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }

  /** A child logger sharing this sink with `fields` merged onto the base. */
  child(fields: Record<string, unknown>): JsonLogger {
    return new JsonLogger(this.sink, { ...this.base, ...fields });
  }

  private emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
    // ts FIRST, then base, then fields: a caller field may override a base field, but
    // the structural keys (level/msg) and ts come from the logger.
    const record: Record<string, unknown> = {
      level,
      msg,
      ts: Date.now(),
      ...this.base,
      ...fields,
    };
    this.sink.write(JSON.stringify(record, bigintSafeReplacer));
  }
}
