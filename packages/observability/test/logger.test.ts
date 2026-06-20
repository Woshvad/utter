// logger.test.ts - the OBS-02 structured JSON logger. Every line is keyed by
// resourceId + idemKey and carries one money-path event. A field ALLOWLIST gates
// the output: secret material (SESSION_SECRET, raw API keys, signatures, private
// keys, bearer tokens) is redacted and its raw value NEVER appears (T-06-LOGLEAK).
// The logger writes through an injectable sink so tests assert the emitted shape;
// the logger source carries zero console.* around secret material.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { StructuredLogger, CaptureSink, REDACTED } from "../src/logger";

const SECRET = "s3cr3t-session-value-never-log-me";

describe("StructuredLogger keying", () => {
  it("keys every line by resourceId + idemKey + the money-path event", () => {
    const sink = new CaptureSink();
    const logger = new StructuredLogger(sink);
    logger.log({ resourceId: "res-1", idemKey: "idem-1", event: "settle" });

    expect(sink.lines).toHaveLength(1);
    const record = JSON.parse(sink.lines[0]!);
    expect(record.resourceId).toBe("res-1");
    expect(record.idemKey).toBe("idem-1");
    expect(record.event).toBe("settle");
  });

  it("accepts each money-path event", () => {
    const sink = new CaptureSink();
    const logger = new StructuredLogger(sink);
    for (const event of ["verify", "reserve", "settle", "release", "strike", "refund"] as const) {
      logger.log({ resourceId: "r", idemKey: "k", event });
    }
    expect(sink.lines).toHaveLength(6);
    expect(sink.lines.map((l) => JSON.parse(l).event)).toEqual([
      "verify",
      "reserve",
      "settle",
      "release",
      "strike",
      "refund",
    ]);
  });
});

describe("redaction allowlist (T-06-LOGLEAK)", () => {
  it("redacts disallowed secret fields; the raw secret never appears in output", () => {
    const sink = new CaptureSink();
    const logger = new StructuredLogger(sink);
    logger.log({
      resourceId: "res-1",
      idemKey: "idem-1",
      event: "verify",
      // these are NOT in the allowlist -> must be redacted/omitted
      sessionSecret: SECRET,
      rawApiKey: "ak_live_leakme",
      signature: "0xdeadbeefsig",
      privateKey: "0xprivkey",
      bearerToken: "Bearer xyz",
    });

    const line = sink.lines[0]!;
    // the raw secret value must NEVER reach the output line
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("ak_live_leakme");
    expect(line).not.toContain("0xdeadbeefsig");
    expect(line).not.toContain("0xprivkey");
    expect(line).not.toContain("Bearer xyz");
  });

  it("passes allowlisted fields through unchanged", () => {
    const sink = new CaptureSink();
    const logger = new StructuredLogger(sink);
    logger.log({
      resourceId: "res-1",
      idemKey: "idem-1",
      event: "settle",
      amountBaseUnits: "2500000",
      latencyMs: 120,
      ok: true,
    });

    const record = JSON.parse(sink.lines[0]!);
    expect(record.amountBaseUnits).toBe("2500000");
    expect(record.latencyMs).toBe(120);
    expect(record.ok).toBe(true);
  });

  it("marks redacted secret keys as REDACTED rather than silently dropping the key signal", () => {
    const sink = new CaptureSink();
    const logger = new StructuredLogger(sink);
    logger.log({
      resourceId: "r",
      idemKey: "k",
      event: "verify",
      signature: SECRET,
    });

    const record = JSON.parse(sink.lines[0]!);
    // the value is replaced with the redaction marker, not the secret
    expect(record.signature).toBe(REDACTED);
    expect(record.signature).not.toBe(SECRET);
  });
});

describe("no console.* around secret material (V7 / OBS-02)", () => {
  it("logger source contains no console.* call", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/logger.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/console\s*\./);
  });
});
