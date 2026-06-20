// computeMeteredAmount suite (PAY-07). Pure bigint metered math:
//   computed = base + perKB*ceil(bytes/1024) + computeMultiplier*ceil(handlerMs/100)
// then clamped to the signed cap, with MAX_RESPONSE_BYTES capping the size term.
// Offline unit test - no env, no chain.
import { describe, it, expect } from "vitest";
import { computeMeteredAmount } from "../src/metering";

const pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
} as const;

describe("metering - computeMeteredAmount (PAY-07)", () => {
  it("sums base + perKB*ceil(bytes/1024) + computeMultiplier*ceil(ms/100) below cap", () => {
    // ceilDiv(2049, 1024) = 3 ; ceilDiv(250, 100) = 3
    // computed = 5000 + 100*3 + 200*3 = 5900
    const amount = computeMeteredAmount(pricing, 2049, 250, 1_000_000n);
    expect(amount).toBe(5000n + 100n * 3n + 200n * 3n);
    expect(amount).toBe(5900n);
  });

  it("clamps a computed value above the cap to exactly the cap", () => {
    // Force computed > cap; result must be the cap, never more.
    const amount = computeMeteredAmount(pricing, 1_000_000, 100_000, 6000n);
    expect(amount).toBe(6000n);
  });

  it("caps the size term at MAX_RESPONSE_BYTES (oversize body does not inflate the charge)", () => {
    const maxResponseBytes = 4096; // 4 KiB cap -> ceilDiv(4096,1024) = 4 size units
    // A body far beyond the cap must use maxResponseBytes for the size term.
    const capped = computeMeteredAmount(
      { ...pricing, maxResponseBytes },
      10_000_000,
      0,
      10_000_000n,
    );
    const atCap = computeMeteredAmount(
      { ...pricing, maxResponseBytes },
      maxResponseBytes,
      0,
      10_000_000n,
    );
    expect(capped).toBe(atCap);
    // 5000 + 100*4 + 0 = 5400
    expect(capped).toBe(5400n);
  });

  it("uses pure bigint (zero work -> just the base)", () => {
    const amount = computeMeteredAmount(pricing, 0, 0, 1_000_000n);
    expect(amount).toBe(5000n);
    expect(typeof amount).toBe("bigint");
  });
});
