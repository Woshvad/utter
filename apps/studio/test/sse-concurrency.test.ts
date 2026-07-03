// sse-concurrency.test.ts - the SSE per-IP CONCURRENT-stream cap (S7b).
//
// Own file so the module singletons read THIS file's knobs: a high open-RATE
// (SSE_LIMIT_PER_IP_PER_MIN=100, so the rate limit never masks the concurrency
// limit) and a low concurrency cap (SSE_MAX_CONCURRENT_PER_IP=2). An SSE stream
// lives up to 15 min holding a BuildChannel entry + a parked reader, so without a
// concurrency cap one IP can pin the global BuildChannel hard cap and lock out real
// build streams. subscribeBuildEvents is stubbed to PARK (yield nothing until the
// lifetime signal aborts) so a held connection deterministically holds its slot -
// the fixture adapter otherwise emits a canned sequence and completes at once.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { BuildEvent } from "../app/adapter/types";

beforeAll(() => {
  process.env.SSE_LIMIT_PER_IP_PER_MIN = "100";
  process.env.SSE_MAX_CONCURRENT_PER_IP = "2";
  process.env.SSE_MAX_CONCURRENT_GLOBAL = "100";
});

/** An async iterable that yields nothing and returns only when `signal` aborts, so
 *  the SSE stream's for-await parks (holding its concurrent slot) until released. */
function parkingIterable(signal: AbortSignal): AsyncIterable<BuildEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

const controllers: AbortController[] = [];
let restore: (() => void) | undefined;

async function installParkingStub(): Promise<void> {
  const selectMod = await import("../app/adapter/select");
  const adapter = selectMod.selectAdapter(process.env);
  const spy = vi
    .spyOn(
      Object.getPrototypeOf(adapter) as {
        subscribeBuildEvents: (id: string, opts?: { signal?: AbortSignal }) => unknown;
      },
      "subscribeBuildEvents",
    )
    .mockImplementation((_id: string, opts?: { signal?: AbortSignal }) =>
      parkingIterable(opts!.signal!),
    );
  restore = () => spy.mockRestore();
}

afterEach(async () => {
  for (const c of controllers) c.abort();
  controllers.length = 0;
  restore?.();
  restore = undefined;
  const { resetSseConcurrencyForTests } = await import("../app/routes/resources.$id.events");
  resetSseConcurrencyForTests();
});

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

/** Open a parked stream from a given IP, returning the Response. Held (not drained). */
async function openStream(ip: string): Promise<Response> {
  const ac = new AbortController();
  controllers.push(ac);
  const request = new Request(`http://localhost/resources/${ID}/events`, {
    headers: { "x-forwarded-for": ip },
    signal: ac.signal,
  });
  const { loader } = await import("../app/routes/resources.$id.events");
  return loader({ params: { id: ID }, request, context: {} } as never) as Promise<Response>;
}

describe("resources.$id.events per-IP concurrency cap (S7b)", () => {
  it("caps concurrent held streams per IP: the 3rd from one IP gets 429 too_many_streams", async () => {
    await installParkingStub();
    const first = await openStream("8.8.8.1");
    const second = await openStream("8.8.8.1");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Third concurrent open from the SAME IP: over the per-IP cap of 2.
    const third = await openStream("8.8.8.1");
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string };
    expect(body.error).toBe("too_many_streams");
  });

  it("the per-IP cap is per IP: a different IP still opens while another is saturated", async () => {
    await installParkingStub();
    await openStream("8.8.8.2");
    await openStream("8.8.8.2");
    const saturated = await openStream("8.8.8.2");
    expect(saturated.status).toBe(429);

    // A different IP has its own budget.
    const other = await openStream("8.8.8.3");
    expect(other.status).toBe(200);
  });

  it("closing a held stream frees its slot so the IP can open again", async () => {
    await installParkingStub();
    await openStream("8.8.8.4");
    const second = await openStream("8.8.8.4");
    expect(second.status).toBe(200);
    const denied = await openStream("8.8.8.4");
    expect(denied.status).toBe(429);

    // Release the held streams by aborting them, then a fresh open is admitted.
    for (const c of controllers) c.abort();
    await new Promise((r) => setTimeout(r, 10)); // let the stream finally release the slot
    const reopened = await openStream("8.8.8.4");
    expect(reopened.status).toBe(200);
  });
});
