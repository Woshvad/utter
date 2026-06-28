// jsonlog.test.ts - the dependency-free JSON-lines logger (provisioning/ops track).
//
// Distinct from the OBS-02 money-path StructuredLogger: this is plain operational
// logging. The assertions: each level emits ONE line that JSON.parses to the right
// level/msg/numeric ts + passed-through fields; a bigint field serializes as its
// base-10 string WITHOUT throwing (plain JSON.stringify throws on bigint); child(base)
// merges its base onto every line over the shared sink.
import { describe, it, expect } from "vitest";
import { JsonLogger, CaptureJsonSink } from "../src/jsonlog";

describe("JsonLogger levels (one line per call)", () => {
  it("info/warn/error each emit exactly one line with the right level/msg/numeric ts", () => {
    const sink = new CaptureJsonSink();
    const logger = new JsonLogger(sink);

    logger.info("informational", { a: 1 });
    logger.warn("a warning", { b: "two" });
    logger.error("an error", { c: true });

    // Exactly one line per call.
    expect(sink.lines).toHaveLength(3);

    const [info, warn, error] = sink.records;
    expect(info).toMatchObject({ level: "info", msg: "informational", a: 1 });
    expect(warn).toMatchObject({ level: "warn", msg: "a warning", b: "two" });
    expect(error).toMatchObject({ level: "error", msg: "an error", c: true });

    // ts is a number on every line.
    for (const r of sink.records) {
      expect(typeof r.ts).toBe("number");
    }
  });

  it("debug emits one line that parses back to the debug level", () => {
    const sink = new CaptureJsonSink();
    new JsonLogger(sink).debug("dbg");
    expect(sink.lines).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ level: "debug", msg: "dbg" });
  });

  it("emits exactly one line per call (no multi-line payloads)", () => {
    const sink = new CaptureJsonSink();
    const logger = new JsonLogger(sink);
    logger.info("first");
    logger.info("second");
    // Two calls -> two lines, and no line contains an embedded newline.
    expect(sink.lines).toHaveLength(2);
    for (const line of sink.lines) {
      expect(line).not.toContain("\n");
    }
  });
});

describe("JsonLogger bigint serialization", () => {
  it("serializes a bigint field as its base-10 string without throwing", () => {
    const sink = new CaptureJsonSink();
    const logger = new JsonLogger(sink);

    // Plain JSON.stringify throws on a bigint; the logger must not.
    expect(() =>
      logger.info("usdc", { amountBaseUnits: 2_500_000n }),
    ).not.toThrow();

    expect(sink.lines).toHaveLength(1);
    expect(sink.records[0]!.amountBaseUnits).toBe("2500000");
  });
});

describe("JsonLogger child(base) merging", () => {
  it("merges the child base onto every line over the SAME sink", () => {
    const sink = new CaptureJsonSink();
    const root = new JsonLogger(sink, { service: "deployer" });
    const child = root.child({ component: "reconcile" });

    child.info("tick", { healthy: true });
    child.warn("event", { phase: "reap" });

    expect(sink.lines).toHaveLength(2);
    for (const r of sink.records) {
      // base from root + base from child appear on every child line.
      expect(r.service).toBe("deployer");
      expect(r.component).toBe("reconcile");
    }
    expect(sink.records[0]).toMatchObject({ msg: "tick", healthy: true });
    expect(sink.records[1]).toMatchObject({ msg: "event", phase: "reap" });
  });

  it("a child does not mutate the parent's base", () => {
    const sink = new CaptureJsonSink();
    const root = new JsonLogger(sink, { service: "deployer" });
    root.child({ component: "reconcile" });

    root.info("root line");
    expect(sink.records[0]!.service).toBe("deployer");
    expect(sink.records[0]!.component).toBeUndefined();
  });
});
