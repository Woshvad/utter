// shutdown.test.ts - the PRIMARY DoD for the graceful-shutdown sequencer.
//
// Drives the EXPORTED runGracefulShutdown().shutdown() against injected fakes that push
// labels into a shared order[] so the test asserts the EXACT teardown ORDER (the load-
// bearing invariant): server.close must precede EVERY closeable, the loop.stop() runs
// after the drain and before the closeables, and the process exits 0. Plus the drain-
// timeout force-close, double-signal idempotency, closeable-failure isolation, the loop-
// absent path, and register(). onExit is injected so the suite never calls process.exit
// and never emits a real signal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runGracefulShutdown, type HttpServerLike } from "../src/shutdown";

/**
 * A fake server that records its lifecycle into a shared order[]. By default close()
 * invokes its callback SYNCHRONOUSLY (an instant clean drain). When `neverDrains` is set
 * it captures the callback but never calls it, so the drain only ends via the timeout.
 */
function makeFakeServer(
  order: string[],
  opts: { neverDrains?: boolean } = {},
): HttpServerLike & { triggerDrain: () => void } {
  let captured: (() => void) | undefined;
  return {
    close(cb?: (err?: Error) => void): unknown {
      order.push("server.close");
      if (!opts.neverDrains) {
        cb?.();
      } else {
        captured = cb ? () => cb() : undefined;
      }
      return undefined;
    },
    closeIdleConnections(): void {
      order.push("closeIdle");
    },
    closeAllConnections(): void {
      order.push("closeAll");
    },
    triggerDrain(): void {
      captured?.();
    },
  };
}

/** A no-op logger so the suite asserts on captured lines without console noise. */
function makeLogger(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runGracefulShutdown teardown order", () => {
  it("runs server.close+closeIdle, then loop.stop, then every closeable, then onExit(0)", async () => {
    const order: string[] = [];
    const server = makeFakeServer(order);
    const exitCodes: number[] = [];
    const logger = makeLogger();

    const { shutdown } = runGracefulShutdown({
      server,
      logger: logger.log,
      onExit: (code) => exitCodes.push(code),
      beforeClosePools: async () => {
        order.push("loop.stop");
      },
      closeables: [
        async () => {
          order.push("pg.end");
        },
        async () => {
          order.push("redis.quit");
        },
      ],
    });

    await shutdown("SIGTERM");

    // The exact teardown order: intake stops first, then the loop, then the pools.
    expect(order).toEqual([
      "server.close",
      "closeIdle",
      "loop.stop",
      "pg.end",
      "redis.quit",
    ]);
    // server.close precedes EVERY closeable (the money-path drain invariant).
    const closeIndex = order.indexOf("server.close");
    for (const closeable of ["pg.end", "redis.quit"]) {
      expect(closeIndex).toBeLessThan(order.indexOf(closeable));
    }
    // A clean shutdown exits 0 exactly once.
    expect(exitCodes).toEqual([0]);
  });
});

describe("runGracefulShutdown drain timeout", () => {
  it("force-closes via closeAllConnections after the drain timeout, then resolves and onExit(0)", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const server = makeFakeServer(order, { neverDrains: true });
    const exitCodes: number[] = [];
    const logger = makeLogger();

    const { shutdown } = runGracefulShutdown({
      server,
      drainTimeoutMs: 5_000,
      logger: logger.log,
      onExit: (code) => exitCodes.push(code),
      closeables: [
        async () => {
          order.push("pg.end");
        },
      ],
    });

    const done = shutdown("SIGTERM");
    // The drain callback is never invoked; advance past the timeout to trigger the
    // force-close path.
    await vi.advanceTimersByTimeAsync(5_001);
    await done;

    // closeAllConnections fired (force-close), the closeable still ran, and we exited 0.
    expect(order).toContain("closeAll");
    expect(order).toContain("pg.end");
    expect(order.indexOf("server.close")).toBeLessThan(order.indexOf("pg.end"));
    expect(exitCodes).toEqual([0]);
    expect(logger.lines.some((l) => l.includes("force-closing"))).toBe(true);
  });
});

describe("runGracefulShutdown double-signal idempotency", () => {
  it("runs server.close + each closeable + onExit exactly once for two unawaited signals", async () => {
    const order: string[] = [];
    const server = makeFakeServer(order);
    const exitCodes: number[] = [];

    const { shutdown } = runGracefulShutdown({
      server,
      logger: () => {},
      onExit: (code) => exitCodes.push(code),
      closeables: [
        async () => {
          order.push("pg.end");
        },
      ],
    });

    // Two signals racing (e.g. SIGTERM immediately followed by SIGINT): the second must
    // return the same in-flight promise and run nothing again.
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    await Promise.all([first, second]);

    expect(order.filter((l) => l === "server.close")).toHaveLength(1);
    expect(order.filter((l) => l === "pg.end")).toHaveLength(1);
    expect(exitCodes).toEqual([0]);
  });
});

describe("runGracefulShutdown closeable failure isolation", () => {
  it("runs the other closeables when one rejects, exits 0, and logs no url/secret", async () => {
    const order: string[] = [];
    const server = makeFakeServer(order);
    const exitCodes: number[] = [];
    const logger = makeLogger();
    const SECRET_URL = "redis://user:s3cr3t@db.internal:6379";

    const { shutdown } = runGracefulShutdown({
      server,
      logger: logger.log,
      onExit: (code) => exitCodes.push(code),
      closeables: [
        async () => {
          order.push("first");
          // Reject with a message that does NOT embed the url (the adapter keeps it
          // private); the sequencer must not synthesize one either.
          throw new Error("redis quit failed");
        },
        async () => {
          order.push("second");
        },
      ],
    });

    await shutdown("SIGTERM");

    // The rejecting closeable did not skip the next one (allSettled).
    expect(order).toContain("first");
    expect(order).toContain("second");
    expect(exitCodes).toEqual([0]);
    // No secret/url leaked into the shutdown log.
    for (const line of logger.lines) {
      expect(line).not.toContain(SECRET_URL);
      expect(line).not.toContain("s3cr3t");
    }
  });
});

describe("runGracefulShutdown without a loop", () => {
  it("skips loop.stop when beforeClosePools is omitted and still drains + closes + exits", async () => {
    const order: string[] = [];
    const server = makeFakeServer(order);
    const exitCodes: number[] = [];

    const { shutdown } = runGracefulShutdown({
      server,
      logger: () => {},
      onExit: (code) => exitCodes.push(code),
      closeables: [
        async () => {
          order.push("close");
        },
      ],
    });

    await shutdown("SIGTERM");

    expect(order).toEqual(["server.close", "closeIdle", "close"]);
    expect(order).not.toContain("loop.stop");
    expect(exitCodes).toEqual([0]);
  });
});

describe("runGracefulShutdown register", () => {
  it("registers one process.once handler per signal and emits no real signal", () => {
    const order: string[] = [];
    const server = makeFakeServer(order);
    const onceSpy = vi.spyOn(process, "once").mockImplementation(
      // Record the registration without attaching a real handler so no signal fires.
      ((..._args: unknown[]) => process) as typeof process.once,
    );

    const { register } = runGracefulShutdown({
      server,
      logger: () => {},
      onExit: () => {},
      signals: ["SIGTERM", "SIGINT"],
    });
    register();

    const registered = onceSpy.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(["SIGTERM", "SIGINT"]);
    // register() must not have run the sequence (no server.close yet).
    expect(order).toEqual([]);
  });
});
