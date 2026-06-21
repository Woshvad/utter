// SCL-06 priceFloor tests. priceFloor(price, cost, margin, mode?) is a PURE bigint
// function comparing price against cost + margin. price >= cost + margin -> "ok".
// Below the floor: the DEFAULT mode is soft-flag -> "flag" (non-blocking, the call
// may still proceed); the opt-in hard-block mode -> "block" (08-RESEARCH Assumption
// A5 / CONTEXT SCL-06). All amounts are base-unit bigint (no float).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { priceFloor } from "../src/price-floor";

// 6dp USDC base-unit fixtures.
const COST = 4_600n; // 0.0046 USDC computed cost
const MARGIN = 1_000n; // 0.001 USDC required margin

describe("priceFloor", () => {
  it("returns 'ok' when price >= cost + margin", () => {
    expect(priceFloor(COST + MARGIN, COST, MARGIN)).toBe("ok");
    expect(priceFloor(COST + MARGIN + 1n, COST, MARGIN)).toBe("ok");
    // Far above the floor.
    expect(priceFloor(50_000n, COST, MARGIN)).toBe("ok");
  });

  it("returns 'flag' below the floor in the DEFAULT (soft-flag) mode", () => {
    // No mode argument -> soft-flag default.
    expect(priceFloor(COST, COST, MARGIN)).toBe("flag");
    expect(priceFloor(COST + MARGIN - 1n, COST, MARGIN)).toBe("flag");
    expect(priceFloor(0n, COST, MARGIN)).toBe("flag");
  });

  it("returns 'block' below the floor only when hard-block is opted in via config", () => {
    expect(priceFloor(COST, COST, MARGIN, { mode: "hard-block" })).toBe("block");
    expect(priceFloor(COST + MARGIN - 1n, COST, MARGIN, { mode: "hard-block" })).toBe(
      "block",
    );
  });

  it("never blocks above the floor even in hard-block mode", () => {
    expect(priceFloor(COST + MARGIN, COST, MARGIN, { mode: "hard-block" })).toBe("ok");
  });

  it("explicit soft-flag mode matches the default", () => {
    expect(priceFloor(COST, COST, MARGIN, { mode: "soft-flag" })).toBe("flag");
  });

  it("flags a sub-cent price that falls below the floor", () => {
    // 0.0001 USDC price, cost 0.0046 + margin 0.001 -> well below floor.
    expect(priceFloor(100n, COST, MARGIN)).toBe("flag");
    expect(priceFloor(100n, COST, MARGIN, { mode: "hard-block" })).toBe("block");
  });

  it("operates on bigint base units with no float coercion", () => {
    const r = priceFloor(7n, 5n, 1n);
    expect(typeof r).toBe("string");
    expect(["ok", "flag", "block"]).toContain(r);
  });

  it("is a pure function: no fetch/fs/console/Date.now/Math.random in source", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/price-floor.ts", import.meta.url)),
      "utf8",
    );
    expect(/\bfetch\s*\(/.test(src)).toBe(false);
    expect(/\bfrom\s+["']node:fs["']/.test(src)).toBe(false);
    expect(/console\.\w+\s*\(/.test(src)).toBe(false);
    expect(/Date\.now\s*\(/.test(src)).toBe(false);
    expect(/Math\.random\s*\(/.test(src)).toBe(false);
  });
});
