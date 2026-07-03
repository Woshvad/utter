// sse-limits.test.ts - the SSE events route admission (S7 route half).
//
// Runs in its own file so the module-singleton SSE limiter is constructed from THIS
// file's low knob (SSE_LIMIT_PER_IP_PER_MIN=1). Covers: the per-IP open limit
// (429 + Retry-After) and the channel-at-capacity pre-stream 503 (driven by a stub
// throw, since the fixture adapter never saturates).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { BuildChannelAtCapacityError } from "../app/adapter/build-channel";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

beforeAll(() => {
  process.env.SSE_LIMIT_PER_IP_PER_MIN = "1";
});

/** Drain a ReadableStream<Uint8Array> to a decoded string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

function eventsRequest(ip: string): Request {
  return new Request(`http://localhost/resources/${ID}/events`, {
    headers: { "x-forwarded-for": ip },
  });
}

describe("resources.$id.events admission (S7)", () => {
  it("limits SSE opens per IP: first streams, second gets 429 + Retry-After", async () => {
    const { loader } = await import("../app/routes/resources.$id.events");

    const first = await loader({
      params: { id: ID },
      request: eventsRequest("6.6.6.1"),
      context: {},
    } as never);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("text/event-stream");
    // Drain to completion so the fixture generator settles cleanly.
    const raw = await drain(first.body as ReadableStream<Uint8Array>);
    expect(raw).toContain("event: stage");

    const denied = await loader({
      params: { id: ID },
      request: eventsRequest("6.6.6.1"),
      context: {},
    } as never);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Content-Type")).toBe("application/json");
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = (await denied.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns a PRE-STREAM 503 when the channel refuses a new stream at capacity", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as { subscribeBuildEvents: () => unknown },
        "subscribeBuildEvents",
      )
      .mockImplementationOnce(() => {
        // The live adapter's subscribe runs the channel admission synchronously,
        // so saturation throws HERE, before any Response exists.
        throw new BuildChannelAtCapacityError(500);
      });

    const { loader } = await import("../app/routes/resources.$id.events");
    const res = await loader({
      params: { id: ID },
      request: eventsRequest("6.6.6.2"),
      context: {},
    } as never);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stream_capacity");
    spy.mockRestore();
  });

  it("still rejects a malformed param before any limiter or adapter work", async () => {
    const { loader } = await import("../app/routes/resources.$id.events");
    const res = await loader({
      params: { id: "../../etc/passwd" },
      request: eventsRequest("6.6.6.3"),
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });
});
