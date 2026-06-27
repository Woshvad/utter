// resources.$id.run.test.ts - the STU-03 playground Run resource route action tests
// (260627-fs1). These moved here from resource-detail.test.ts because the Run logic now
// lives in the run resource route (resources.$id.run.ts) so a plain fetch + res.json()
// reads real JSON instead of the rendered HTML document.
//
// The action drives adapter.runPlayground and returns a REAL Response. A successful run
// serializes the bigint debit to a string; a rejected hosted run returns an error-shaped
// 200 (never a non-Response throw the client fetch sees as an unparseable 500); a bad
// param returns a 400 before reaching the adapter (the isSafeParam gate).
import { describe, it, expect, vi } from "vitest";

const ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

describe("resources.$id.run action (playground Run resource route)", () => {
  it("returns a 200 JSON Response with the serialized result on a successful run", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as { runPlayground: () => unknown },
        "runPlayground",
      )
      .mockResolvedValueOnce({
        paid: true,
        debitAmount: 12000n,
        body: { echo: "hi", length: 2 },
        bodyBytes: 20,
        handlerMs: 5,
      });

    const { action } = await import("../app/routes/resources.$id.run");
    const res = (await action({
      params: { id: ID },
      request: new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
      }),
      context: {},
    } as never)) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const data = (await res.json()) as {
      paid: boolean;
      debitAmount: string;
      body: { echo: string; length: number };
      bodyBytes: number;
      handlerMs: number;
    };
    expect(data.paid).toBe(true);
    // the bigint debit is serialized to a string for the wire
    expect(data.debitAmount).toBe("12000");
    expect(data.body).toEqual({ echo: "hi", length: 2 });
    expect(data.bodyBytes).toBe(20);
    expect(data.handlerMs).toBe(5);

    spy.mockRestore();
  });

  it("returns an error-shaped 200 JSON Response (NOT a throw) when runPlayground rejects", async () => {
    const selectMod = await import("../app/adapter/select");
    const adapter = selectMod.selectAdapter(process.env);
    const spy = vi
      .spyOn(
        Object.getPrototypeOf(adapter) as { runPlayground: () => unknown },
        "runPlayground",
      )
      .mockRejectedValueOnce(new Error("hosted boom"));
    // console.error on this path is expected; silence it to keep the suite output clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { action } = await import("../app/routes/resources.$id.run");
    let res: Response | undefined;
    let thrown: unknown;
    try {
      res = (await action({
        params: { id: ID },
        request: new Request("http://x/", {
          method: "POST",
          body: JSON.stringify({ text: "hi" }),
        }),
        context: {},
      } as never)) as Response;
    } catch (e) {
      thrown = e;
    }

    // No throw, and the result is an error-shaped 200 JSON Response.
    expect(thrown).toBeUndefined();
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("application/json");
    const data = await res!.json();
    expect(data).toEqual({
      paid: false,
      debitAmount: "0",
      body: { error: "hosted boom" },
      bodyBytes: 0,
      handlerMs: 0,
      paywall: null,
    });

    errSpy.mockRestore();
    spy.mockRestore();
  });

  it("returns a 400 JSON Response (no throw) for a malformed :id param", async () => {
    const { action } = await import("../app/routes/resources.$id.run");
    let res: Response | undefined;
    let thrown: unknown;
    try {
      res = (await action({
        params: { id: "../../etc/passwd" },
        request: new Request("http://x/", { method: "POST" }),
        context: {},
      } as never)) as Response;
    } catch (e) {
      thrown = e;
    }

    // The bad param is rejected before the adapter, as a 400 Response (never a throw).
    expect(thrown).toBeUndefined();
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
    expect(res!.headers.get("Content-Type")).toBe("application/json");
  });
});
