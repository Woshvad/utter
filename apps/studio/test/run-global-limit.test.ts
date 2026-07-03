// run-global-limit.test.ts - the playground run route GLOBAL backstop (S6 - IPv6
// rotation). Own file so the module-singleton run limiters read THIS file's knobs: a
// high per-IP window (so it never masks the global) and a low global window, so
// distinct-IP runs (each under the per-IP limit) exhaust the platform-wide backstop.
import { describe, it, expect, vi, beforeAll } from "vitest";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
  process.env.RUN_LIMIT_PER_IP_PER_MIN = "100";
  process.env.RUN_LIMIT_GLOBAL_PER_MIN = "2";
});

function runRequest(ip: string): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify({ text: "hi" }),
  });
}

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

describe("resources.$id.run global backstop (S6)", () => {
  it("denies once the platform-wide window is exhausted even across distinct IPs", async () => {
    const stub = await stubRunPlayground();
    const { action } = await import("../app/routes/resources.$id.run");

    // Two distinct IPs, each under the per-IP window, consume the global budget of 2.
    const first = (await action({ params: { id: ID }, request: runRequest("11.1.1.1"), context: {} } as never)) as Response;
    const second = (await action({ params: { id: ID }, request: runRequest("11.1.1.2"), context: {} } as never)) as Response;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // A THIRD distinct IP is under its own per-IP limit but the global window is spent.
    const denied = (await action({ params: { id: ID }, request: runRequest("11.1.1.3"), context: {} } as never)) as Response;
    expect(denied.status).toBe(429);
    const data = (await denied.json()) as { paid: boolean; debitAmount: string; body: { error: string } };
    expect(data.paid).toBe(false);
    expect(BigInt(data.debitAmount)).toBe(0n);
    expect(data.body.error).toBe("rate_limited");
    stub.restore();
  });
});
