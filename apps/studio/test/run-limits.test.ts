// run-limits.test.ts - the playground run route admission (S6).
//
// Runs in its own file so the module-singleton run limiter is constructed from THIS
// file's low knob (RUN_LIMIT_PER_IP_PER_MIN=1). Every request carries a distinct
// x-forwarded-for so each case owns a fresh IP bucket; the per-creator bucket cases
// reuse one session across two IPs. Covers: the 429 body being EXACTLY
// PlaygroundResult-shaped (the client does BigInt(data.debitAmount) and reads
// paid/debitAmount/body/bodyBytes/handlerMs/paywall without checking res.ok), the
// creator bucket when a session is present, and the PLAYGROUND_HARNESS=live
// owner gate (anon 401, non-owner 403, owner runs).
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { FIXTURE_CREATOR } from "../app/fixtures/index";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.RUN_LIMIT_PER_IP_PER_MIN = "1";
});

afterEach(() => {
  delete process.env.PLAYGROUND_HARNESS;
});

/** Commit a session for the given address and return its Cookie header value. */
async function sessionCookie(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

/** A run POST with a fixed body and per-case forwarded IP / cookie. */
function runRequest(ip: string, cookie?: string): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ text: "hi" }),
  });
}

/** Stub the adapter runPlayground so the allowed path is deterministic. */
async function stubRunPlayground(): Promise<{ restore: () => void }> {
  const selectMod = await import("../app/adapter/select");
  const adapter = selectMod.selectAdapter(process.env);
  const spy = vi
    .spyOn(
      Object.getPrototypeOf(adapter) as { runPlayground: () => unknown },
      "runPlayground",
    )
    .mockResolvedValue({ paid: true, debitAmount: 12000n, body: { ok: true } });
  return { restore: () => spy.mockRestore() };
}

describe("resources.$id.run admission (S6)", () => {
  it("denies over-limit IPs with a 429 whose body is EXACTLY PlaygroundResult-shaped", async () => {
    const stub = await stubRunPlayground();
    const { action } = await import("../app/routes/resources.$id.run");

    const first = (await action({
      params: { id: ID },
      request: runRequest("9.9.9.1"),
      context: {},
    } as never)) as Response;
    expect(first.status).toBe(200);

    const denied = (await action({
      params: { id: ID },
      request: runRequest("9.9.9.1"),
      context: {},
    } as never)) as Response;
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Content-Type")).toBe("application/json");
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    const data = (await denied.json()) as {
      paid: boolean;
      debitAmount: string;
      body: { error: string; retryAfterMs: number };
      bodyBytes: number;
      handlerMs: number;
      paywall: null;
    };
    // The exact field set the resources.$id.tsx onRun handler parses.
    expect(Object.keys(data).sort()).toEqual(
      ["body", "bodyBytes", "debitAmount", "handlerMs", "paid", "paywall"].sort(),
    );
    expect(data.paid).toBe(false);
    // The client does BigInt(data.debitAmount) unconditionally; "0" must parse.
    expect(BigInt(data.debitAmount)).toBe(0n);
    expect(data.body.error).toBe("rate_limited");
    expect(data.body.retryAfterMs).toBeGreaterThan(0);
    expect(data.bodyBytes).toBe(0);
    expect(data.handlerMs).toBe(0);
    expect(data.paywall).toBeNull();
    stub.restore();
  });

  it("also buckets by creator when a session is present (fresh IP still denied)", async () => {
    const stub = await stubRunPlayground();
    const { action } = await import("../app/routes/resources.$id.run");
    const cookie = await sessionCookie("0x2222000000000000000000000000000000000002");

    const first = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.1", cookie),
      context: {},
    } as never)) as Response;
    expect(first.status).toBe(200);

    // Same creator from a DIFFERENT IP: the creator bucket (same limit) denies.
    const denied = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.2", cookie),
      context: {},
    } as never)) as Response;
    expect(denied.status).toBe(429);
    stub.restore();
  });

  it("PLAYGROUND_HARNESS=live requires auth: an anonymous run RETURNS a 401 in PlaygroundResult shape", async () => {
    // The owner gate throws a bare 401 Response; the route must convert it to a
    // PlaygroundResult-shaped body (debitAmount "0"), NOT let it propagate raw -
    // the client does BigInt(data.debitAmount) unconditionally and would crash on
    // an {error} body (the P3 fix).
    process.env.PLAYGROUND_HARNESS = "live";
    const { action } = await import("../app/routes/resources.$id.run");
    const res = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.3"),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const data = (await res.json()) as {
      paid: boolean;
      debitAmount: string;
      body: { error: string };
      bodyBytes: number;
      handlerMs: number;
      paywall: null;
    };
    expect(Object.keys(data).sort()).toEqual(
      ["body", "bodyBytes", "debitAmount", "handlerMs", "paid", "paywall"].sort(),
    );
    expect(data.paid).toBe(false);
    expect(BigInt(data.debitAmount)).toBe(0n);
    expect(data.body.error).toMatch(/sign in/i);
  });

  it("PLAYGROUND_HARNESS=live rejects a NON-owner session with a 403 in PlaygroundResult shape", async () => {
    process.env.PLAYGROUND_HARNESS = "live";
    const { action } = await import("../app/routes/resources.$id.run");
    const cookie = await sessionCookie("0x3333000000000000000000000000000000000003");
    const res = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.4", cookie),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(403);
    const data = (await res.json()) as { paid: boolean; debitAmount: string; body: { error: string } };
    expect(data.paid).toBe(false);
    expect(BigInt(data.debitAmount)).toBe(0n);
    expect(data.body.error).toMatch(/owner/i);
  });

  it("PLAYGROUND_HARNESS=live lets the resource OWNER run", async () => {
    process.env.PLAYGROUND_HARNESS = "live";
    const stub = await stubRunPlayground();
    const { action } = await import("../app/routes/resources.$id.run");
    // The fixture detail's creator is FIXTURE_CREATOR for every id.
    const cookie = await sessionCookie(FIXTURE_CREATOR);
    const res = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.5", cookie),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    const data = (await res.json()) as { paid: boolean; debitAmount: string };
    expect(data.paid).toBe(true);
    expect(BigInt(data.debitAmount)).toBe(12000n);
    stub.restore();
  });

  it("the default mock harness stays public (no session required)", async () => {
    const stub = await stubRunPlayground();
    const { action } = await import("../app/routes/resources.$id.run");
    const res = (await action({
      params: { id: ID },
      request: runRequest("10.0.0.6"),
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    stub.restore();
  });
});
