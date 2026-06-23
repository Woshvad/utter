// auth-wiring.test.ts - the CR-01 regression guard: the access gate is WIRED INTO the
// live route loaders/actions, not just the helper. The pre-existing auth-gate.test.ts
// exercised requireCreator/requireResourceOwner DIRECTLY (a false green while the
// routes stayed open); these tests drive the actual route modules so they FAIL against
// the ungated code and PASS after the gate is installed.
//
// Also covers:
//   - WR-01: every route registered in routes.ts resolves to a real module (smoke).
//   - WR-02: the /keys mint -> reveal-once -> programmatic-verify flow end to end.
import { describe, it, expect, beforeAll } from "vitest";
import { FIXTURE_CREATOR, FIXTURE_RESOURCE_ID } from "../app/fixtures/index";

const STRANGER = "0x2222222222222222222222222222222222222222";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
});

/** Commit a session for `address` and return its Cookie header value. */
async function cookieFor(address: string): Promise<string> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", address);
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

/** A document (text/html) navigation - the gate should redirect these to /auth. */
function docRequest(url: string, method = "GET", cookie?: string): Request {
  const headers: Record<string, string> = { Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  return new Request(url, { method, headers });
}

/** A data/fetch request (no html Accept) - the gate should 401 these. */
function dataRequest(url: string, method = "GET", cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return new Request(url, { method, headers });
}

/** Run a loader/action and capture whatever it throws (Response) or returns. */
async function run(fn: (args: never) => unknown, request: Request): Promise<unknown> {
  try {
    return await fn({ request, params: {}, context: {} } as never);
  } catch (thrown) {
    return thrown;
  }
}

describe("CR-01: /create action is gated (wiring, not just the helper)", () => {
  it("redirects an unauthenticated document POST to /auth (302)", async () => {
    const { action } = await import("../app/routes/create");
    const out = await run(action as never, docRequest("http://x/create", "POST"));
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth");
  });

  it("401s an unauthenticated data POST (no html Accept)", async () => {
    const { action } = await import("../app/routes/create");
    const out = await run(action as never, dataRequest("http://x/create", "POST"));
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(401);
  });

  it("allows an authenticated POST through to validation", async () => {
    const { action } = await import("../app/routes/create");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const body = new URLSearchParams({
      prompt: "return the current weather for a city",
      pricingModel: "flat",
      basePrice: "0.010000",
      bond: "5.000000",
      payout: "0x1111111111111111111111111111111111111111",
    }).toString();
    const req = new Request("http://x/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body,
    });
    const result = (await action({ request: req, params: {}, context: {} } as never)) as {
      ok: boolean;
    };
    // an authed valid submit passes the gate AND validation -> a created resource
    expect(result.ok).toBe(true);
  });
});

describe("CR-01: /dashboard loader is gated", () => {
  it("redirects an unauthenticated document GET to /auth", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const out = await run(loader as never, docRequest("http://x/dashboard"));
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(302);
  });

  it("401s an unauthenticated data GET", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const out = await run(loader as never, dataRequest("http://x/dashboard"));
    expect((out as Response).status).toBe(401);
  });

  it("returns revenue data for an authenticated GET", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const data = (await loader({
      request: dataRequest("http://x/dashboard", "GET", cookie),
      params: {},
      context: {},
    } as never)) as { revenue: unknown };
    expect(data.revenue).toBeTruthy();
  });
});

describe("CR-01: /wallet loader is gated", () => {
  it("redirects an unauthenticated document GET to /auth", async () => {
    const { loader } = await import("../app/routes/wallet");
    const out = await run(loader as never, docRequest("http://x/wallet"));
    expect((out as Response).status).toBe(302);
  });

  it("401s an unauthenticated data GET", async () => {
    const { loader } = await import("../app/routes/wallet");
    const out = await run(loader as never, dataRequest("http://x/wallet"));
    expect((out as Response).status).toBe(401);
  });

  it("returns the decimals payload for an authenticated GET", async () => {
    const { loader } = await import("../app/routes/wallet");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const data = (await loader({
      request: dataRequest("http://x/wallet", "GET", cookie),
      params: {},
      context: {},
    } as never)) as { decimals: number };
    expect(typeof data.decimals).toBe("number");
  });
});

describe("CR-01: requireResourceOwner blocks cross-creator (403)", () => {
  it("403s when a different creator targets the resource", async () => {
    const { requireResourceOwner } = await import("../app/auth/requireCreator.server");
    const cookie = await cookieFor(STRANGER); // != FIXTURE_CREATOR
    const req = dataRequest("http://x/resources/x", "POST", cookie);
    const out = await run(
      ((args: never) => requireResourceOwner((args as { request: Request }).request, FIXTURE_RESOURCE_ID)) as never,
      req,
    );
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
  });

  it("allows the owning creator through", async () => {
    const { requireResourceOwner } = await import("../app/auth/requireCreator.server");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const req = dataRequest("http://x/resources/x", "POST", cookie);
    const addr = await requireResourceOwner(req, FIXTURE_RESOURCE_ID);
    expect(addr.toLowerCase()).toBe(FIXTURE_CREATOR.toLowerCase());
  });
});

describe("WR-01: every registered route resolves to a module", () => {
  it("resolves all routes in routes.ts", async () => {
    const routesMod = await import("../app/routes");
    type RouteEntry = { file: string; children?: readonly RouteEntry[] };
    const config = routesMod.default as ReadonlyArray<RouteEntry>;
    expect(config.length).toBeGreaterThan(0);
    // The in-app routes are nested under the _shell layout route, so flatten the tree
    // (top-level + children) before asserting every registered file resolves.
    const flatten = (entries: readonly RouteEntry[]): string[] =>
      entries.flatMap((e) => [e.file, ...(e.children ? flatten(e.children) : [])]);
    const files = flatten(config);
    // the three formerly-dead routes (WR-01) must now be registered
    expect(files).toContain("routes/dashboard.tsx");
    expect(files).toContain("routes/wallet.tsx");
    expect(files).toContain("routes/metrics.ts");
    // each registered module is loadable (the file exists and parses). The route
    // files are loaded statically (Vite needs a static import specifier) and matched
    // against the registry so a registered-but-missing module would fail here.
    const modules: Record<string, () => Promise<unknown>> = {
      "routes/_index.tsx": () => import("../app/routes/_index"),
      "routes/_shell.tsx": () => import("../app/routes/_shell"),
      "routes/create.tsx": () => import("../app/routes/create"),
      "routes/discover.tsx": () => import("../app/routes/discover"),
      "routes/mcp.tsx": () => import("../app/routes/mcp"),
      "routes/dashboard.tsx": () => import("../app/routes/dashboard"),
      "routes/wallet.tsx": () => import("../app/routes/wallet"),
      "routes/keys.tsx": () => import("../app/routes/keys"),
      "routes/metrics.ts": () => import("../app/routes/metrics"),
      "routes/resources.$id.tsx": () => import("../app/routes/resources.$id"),
      "routes/resources.$id.events.ts": () => import("../app/routes/resources.$id.events"),
      "routes/creators.$address.tsx": () => import("../app/routes/creators.$address"),
      "routes/auth.tsx": () => import("../app/routes/auth"),
    };
    for (const rel of files) {
      const importer = modules[rel];
      expect(importer, `route ${rel} has no static importer in the smoke test`).toBeTruthy();
      const mod = await importer!();
      expect(mod).toBeTruthy();
    }
  });
});

describe("WR-02: API-key mint -> reveal-once -> programmatic verify (end to end)", () => {
  it("anon cannot mint a key (gated)", async () => {
    const { action } = await import("../app/routes/keys");
    const out = await run(action as never, dataRequest("http://x/keys", "POST"));
    expect((out as Response).status).toBe(401);
  });

  it("an authenticated creator mints a raw key (shown once) and can then authenticate with it", async () => {
    const { action } = await import("../app/routes/keys");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const minted = (await action({
      request: dataRequest("http://x/keys", "POST", cookie),
      params: {},
      context: {},
    } as never)) as { mintedRaw: string };

    expect(minted.mintedRaw).toMatch(/^utk_/);

    // the programmatic (non-SIWE) auth path verifies the raw key for that creator
    const { requireApiKeyCreator } = await import("../app/auth/apiKeyStore.server");
    const bearerReq = new Request("http://x/api", {
      headers: { Authorization: `Bearer ${minted.mintedRaw}` },
    });
    const who = await requireApiKeyCreator(bearerReq, FIXTURE_CREATOR);
    expect(who.toLowerCase()).toBe(FIXTURE_CREATOR.toLowerCase());

    // a wrong/absent key 401s
    const badReq = new Request("http://x/api", {
      headers: { Authorization: "Bearer utk_not-a-real-key" },
    });
    const out = await run(
      ((args: never) => requireApiKeyCreator((args as { request: Request }).request, FIXTURE_CREATOR)) as never,
      badReq,
    );
    expect((out as Response).status).toBe(401);
  });

  it("the loader lists only MASKED references (never the raw key)", async () => {
    const { action, loader } = await import("../app/routes/keys");
    const cookie = await cookieFor(STRANGER);
    const minted = (await action({
      request: dataRequest("http://x/keys", "POST", cookie),
      params: {},
      context: {},
    } as never)) as { mintedRaw: string };

    const listed = (await loader({
      request: dataRequest("http://x/keys", "GET", cookie),
      params: {},
      context: {},
    } as never)) as { existing: string[] };

    expect(listed.existing.length).toBeGreaterThan(0);
    // the masked reference must NOT equal or contain the raw key body
    for (const ref of listed.existing) {
      expect(ref).not.toContain(minted.mintedRaw);
      expect(ref).toMatch(/^utk_••••/);
    }
  });
});

describe("WR-02b: a valid bearer key authenticates through requireCreator (gate consumer)", () => {
  it("a DATA request bearing a minted key passes the gate and resolves to the minting creator", async () => {
    // mint a key as FIXTURE_CREATOR via the SIWE-gated /keys action
    const { action } = await import("../app/routes/keys");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const minted = (await action({
      request: dataRequest("http://x/keys", "POST", cookie),
      params: {},
      context: {},
    } as never)) as { mintedRaw: string };
    expect(minted.mintedRaw).toMatch(/^utk_/);

    // a data request with NO session cookie but a Bearer key resolves through the gate
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const bearerReq = new Request("http://x/dashboard", {
      headers: { Authorization: `Bearer ${minted.mintedRaw}` },
    });
    const who = await requireCreator(bearerReq);
    expect(who.toLowerCase()).toBe(FIXTURE_CREATOR.toLowerCase());
  });

  it("a gated loader (dashboard) accepts a bearer key in place of a session", async () => {
    const { action } = await import("../app/routes/keys");
    const cookie = await cookieFor(FIXTURE_CREATOR);
    const minted = (await action({
      request: dataRequest("http://x/keys", "POST", cookie),
      params: {},
      context: {},
    } as never)) as { mintedRaw: string };

    const { loader } = await import("../app/routes/dashboard");
    const data = (await loader({
      request: new Request("http://x/dashboard", {
        headers: { Authorization: `Bearer ${minted.mintedRaw}` },
      }),
      params: {},
      context: {},
    } as never)) as { revenue: unknown };
    expect(data.revenue).toBeTruthy();
  });

  it("a bad bearer key still 401s a data request (no session)", async () => {
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const badReq = new Request("http://x/dashboard", {
      headers: { Authorization: "Bearer utk_not-a-real-key" },
    });
    const out = await run(
      ((args: never) => requireCreator((args as { request: Request }).request)) as never,
      badReq,
    );
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(401);
  });

  it("an absent bearer key (and no session) still 401s a data request", async () => {
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const out = await run(
      ((args: never) => requireCreator((args as { request: Request }).request)) as never,
      dataRequest("http://x/dashboard"),
    );
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(401);
  });

  it("an unauthenticated document request still redirects to /auth (302), bearer or not", async () => {
    const { requireCreator } = await import("../app/auth/requireCreator.server");
    const out = await run(
      ((args: never) => requireCreator((args as { request: Request }).request)) as never,
      docRequest("http://x/dashboard"),
    );
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(302);
    expect((out as Response).headers.get("Location")).toBe("/auth");
  });
});

describe("IN-01: BuildStream live-URL scheme validation", () => {
  it("accepts http(s) URLs and rejects javascript:/data: schemes", async () => {
    const { safeHttpUrl } = await import("../app/components/build/BuildStream");
    expect(safeHttpUrl("https://weather.resources.example.com")).toBe(
      "https://weather.resources.example.com",
    );
    expect(safeHttpUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
