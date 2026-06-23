// dashboard.test.ts - STU-04 revenue dashboard loader + screen tests.
//
// Covers: (1) the loader aggregates calls/gross/creator+platform/refunds + the
// settle/refund receipts through the adapter, with a runtime decimals (no literal);
// (2) the screen renders every money figure mono 6dp via UsdcAmount and the
// creator/platform split equals the projected receipt amounts (not recomputed,
// T-06-REDERIVE); (3) a TxLink per settle/refund row points at ARC_EXPLORER + the
// receipt hash; (4) a source grep finds no 1e6/6/18 money literal in the render path.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// The dashboard loader is now gated by requireCreator (CR-01); the loader tests must
// carry a valid session cookie.
beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough-32b";
});

const CREATOR = "0x1111111111111111111111111111111111111111";

/** An authenticated GET Request (carries a committed session for CREATOR). */
async function authedGet(url: string): Promise<Request> {
  const { sessionStorage } = await import("../app/auth/session.server");
  const session = await sessionStorage.getSession();
  session.set("address", CREATOR);
  const setCookie = await sessionStorage.commitSession(session);
  return new Request(url, { headers: { Cookie: setCookie.split(";")[0]! } });
}

describe("dashboard loader (read-through revenue)", () => {
  it("aggregates calls/gross/creator+platform/refunds + receipts through the adapter", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: await authedGet("http://x/dashboard"),
      context: {},
    } as never);

    expect(typeof data.revenue.calls).toBe("number");
    expect(typeof data.revenue.gross).toBe("bigint");
    expect(typeof data.revenue.creatorShare).toBe("bigint");
    expect(typeof data.revenue.platformShare).toBe("bigint");
    expect(typeof data.revenue.refunds).toBe("bigint");
    // decimals came from a runtime read through the adapter (not a literal)
    expect(typeof data.decimals).toBe("number");
    // the settle/refund receipts back the ArcScan TxLinks
    expect(Array.isArray(data.revenue.receipts)).toBe(true);
    expect(data.revenue.receipts.length).toBeGreaterThan(0);
    for (const r of data.revenue.receipts) {
      expect(r.tx).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(["settle", "refund"]).toContain(r.kind);
      expect(typeof r.amount).toBe("bigint");
    }
    // an explorer base is resolved for the TxLinks (ARC_EXPLORER or chain default)
    expect(typeof data.explorer).toBe("string");
    expect(data.explorer.length).toBeGreaterThan(0);
  });

  it("the creator+platform split equals the projected aggregate (no recompute)", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: await authedGet("http://x/dashboard"),
      context: {},
    } as never);
    // creator + platform sums to gross (the projected split, not a recomputed one)
    expect(data.revenue.creatorShare + data.revenue.platformShare).toBe(data.revenue.gross);
    // the settle receipts sum to gross; the refund receipts sum to refunds
    const settles = data.revenue.receipts.filter((r) => r.kind === "settle");
    const refunds = data.revenue.receipts.filter((r) => r.kind === "refund");
    expect(settles.reduce((s, r) => s + r.amount, 0n)).toBe(data.revenue.gross);
    expect(refunds.reduce((s, r) => s + r.amount, 0n)).toBe(data.revenue.refunds);
  });

  it("honors a ?resource= query param shape and falls back safely on a bad one", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const bad = await loader({
      params: {},
      request: await authedGet("http://x/dashboard?resource=../../etc/passwd"),
      context: {},
    } as never);
    // a malformed resource param does not throw; it falls back to the canonical id
    expect(bad.revenue).toBeTruthy();
  });
});

describe("dashboard loader (aggregates + per-resource rows)", () => {
  it("sums earnings/calls, counts live, and builds a row per listed resource", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: await authedGet("http://x/dashboard"),
      context: {},
    } as never);

    // one row per listed marketplace card (fixture has 2)
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(typeof row.revenue).toBe("bigint");
      expect(typeof row.calls).toBe("number");
      expect(typeof row.bond).toBe("bigint");
      expect(typeof row.active).toBe("boolean");
      expect(typeof row.slug).toBe("string");
    }

    // totals are the read-through sums, never recomputed splits
    expect(data.totals.earnings).toBe(data.rows.reduce((s, r) => s + r.revenue, 0n));
    expect(data.totals.calls).toBe(data.rows.reduce((s, r) => s + r.calls, 0));
    expect(data.totals.liveApis).toBe(data.rows.filter((r) => r.active).length);
    expect(data.totals.strikes).toBe(data.alerts.length);
  });
});

describe("dashboard screen (comp stat cells + table + ArcScan disclosure)", () => {
  it("renders the 4 stat cells, the resource rows, and a TxLink per receipt", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: await authedGet("http://x/dashboard"),
      context: {},
    } as never);

    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, useLoaderData: () => data };
    });

    const { render, screen } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../app/routes/dashboard");
    const Screen = mod.default;

    render(React.createElement(Screen));

    // the four comp stat cells are present
    expect(screen.getByTestId("stat-total-earnings")).toBeInTheDocument();
    expect(screen.getByTestId("stat-calls-30d")).toBeInTheDocument();
    expect(screen.getByTestId("stat-live-apis")).toBeInTheDocument();
    expect(screen.getByTestId("stat-strikes")).toBeInTheDocument();

    // TOTAL EARNINGS renders mono via UsdcAmount (the money surface)
    const monies = screen.getAllByTestId("usdc-amount");
    expect(monies.length).toBeGreaterThan(0);

    // the yellow withdraw-earnings action targets /wallet
    expect(screen.getByTestId("withdraw-earnings").getAttribute("href")).toContain("/wallet");

    // one resource row per loader row, each linking to /resources/<id>
    const rows = screen.getAllByTestId("resource-row");
    expect(rows.length).toBe(data.rows.length);
    for (const r of rows) {
      expect(r.getAttribute("href")).toContain("/resources/");
    }

    // KEEP FUNCTION: a TxLink per receipt row in the settlements disclosure, each
    // pointing at the explorer base + the hash
    const txLinks = screen.getAllByTestId("tx-link");
    expect(txLinks.length).toBe(data.revenue.receipts.length);
    for (const link of txLinks) {
      const href = link.getAttribute("href")!;
      expect(href).toContain(data.explorer.replace(/\/+$/, ""));
      expect(href).toContain("/tx/0x");
    }

    vi.doUnmock("react-router");
  });
});

describe("dashboard render path (no money literal)", () => {
  const FILES = [
    "../app/routes/dashboard.tsx",
    "../app/components/dashboard/RevenuePanel.tsx",
    "../app/components/dashboard/ResourceTable.tsx",
    "../app/components/primitives/TxLink.tsx",
  ];

  it("contains no 1e6/10**6//1000000/6n/18n money-scale literal in the render path", () => {
    // Strip line + block comments, then assert no scale literal (T-06-DECIMALS).
    const forbidden = [/1e6/i, /10\s*\*\*\s*6/, /\/\s*1000000/, /\b6n\b/, /\b18n\b/, /BigInt\(\s*6\s*\)/, /BigInt\(\s*18\s*\)/];
    for (const rel of FILES) {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const re of forbidden) {
        expect(stripped, `${rel} should carry no money-scale literal (${re})`).not.toMatch(re);
      }
    }
  });
});
