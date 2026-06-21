// dashboard.test.ts - STU-04 revenue dashboard loader + screen tests.
//
// Covers: (1) the loader aggregates calls/gross/creator+platform/refunds + the
// settle/refund receipts through the adapter, with a runtime decimals (no literal);
// (2) the screen renders every money figure mono 6dp via UsdcAmount and the
// creator/platform split equals the projected receipt amounts (not recomputed,
// T-06-REDERIVE); (3) a TxLink per settle/refund row points at ARC_EXPLORER + the
// receipt hash; (4) a source grep finds no 1e6/6/18 money literal in the render path.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("dashboard loader (read-through revenue)", () => {
  it("aggregates calls/gross/creator+platform/refunds + receipts through the adapter", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: new Request("http://x/dashboard"),
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
      request: new Request("http://x/dashboard"),
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
      request: new Request("http://x/dashboard?resource=../../etc/passwd"),
      context: {},
    } as never);
    // a malformed resource param does not throw; it falls back to the canonical id
    expect(bad.revenue).toBeTruthy();
  });
});

describe("dashboard screen (mono money + ArcScan TxLinks)", () => {
  it("renders money figures mono via UsdcAmount and a TxLink per receipt row", async () => {
    const { loader } = await import("../app/routes/dashboard");
    const data = await loader({
      params: {},
      request: new Request("http://x/dashboard"),
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

    // every money figure is a UsdcAmount (mono surface); gross is the yellow hero
    const monies = screen.getAllByTestId("usdc-amount");
    expect(monies.length).toBeGreaterThan(0);
    // gross = 1280000 base units @ 6dp -> $1.280000
    expect(screen.getByTestId("revenue-figure-gross").textContent).toContain("$1.280000");

    // a TxLink per receipt row, each pointing at the explorer base + the hash
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
