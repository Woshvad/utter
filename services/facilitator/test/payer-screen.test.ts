// Unit suite for the payer sanctions screen (Compliance track, subtask 1). Verifies the
// in-memory denylist behavior in isolation (no Hono, no money path): a non-listed payer
// is allowed, a listed payer is denied case-insensitively, an empty list allows all, and
// createPayerScreenFromList lowercases + drops empty entries.
import { describe, it, expect } from "vitest";
import { InMemoryPayerScreen, createPayerScreenFromList } from "../src/payer-screen";

describe("InMemoryPayerScreen", () => {
  it("allows a payer that is NOT on the denylist", async () => {
    const screen = createPayerScreenFromList(["0xdeadbeef00000000000000000000000000000001"]);
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000002")).toBe(true);
  });

  it("denies a listed payer case-insensitively (the claimed buyer is lowercased)", async () => {
    const screen = createPayerScreenFromList(["0xAbCdEf0000000000000000000000000000000001"]);
    // Same address, different casing -> still denied.
    expect(await screen.isAllowed("0xABCDEF0000000000000000000000000000000001")).toBe(false);
    expect(await screen.isAllowed("0xabcdef0000000000000000000000000000000001")).toBe(false);
  });

  it("an empty denylist allows everyone", async () => {
    const screen = createPayerScreenFromList([]);
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000003")).toBe(true);
  });

  it("a denylist of only blank/whitespace entries allows everyone (entries dropped)", async () => {
    const screen = createPayerScreenFromList(["", "   ", "\t"]);
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000004")).toBe(true);
  });

  it("constructed directly from a Set of lowercased addresses, denies a member", async () => {
    const screen = new InMemoryPayerScreen(
      new Set(["0xabcdef0000000000000000000000000000000005"]),
    );
    expect(await screen.isAllowed("0xABCDEF0000000000000000000000000000000005")).toBe(false);
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000006")).toBe(true);
  });
});

describe("createPayerScreenFromList", () => {
  it("lowercases entries so a mixed-case denylist still matches a mixed-case payer", async () => {
    const screen = createPayerScreenFromList(["  0xAbCDeF0000000000000000000000000000000007  "]);
    // The entry is trimmed + lowercased; the payer is matched after lowercasing too.
    expect(await screen.isAllowed("0xABCDEF0000000000000000000000000000000007")).toBe(false);
  });

  it("drops empty + whitespace entries while keeping real ones", async () => {
    const screen = createPayerScreenFromList([
      "",
      "0x0000000000000000000000000000000000000008",
      "   ",
    ]);
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000008")).toBe(false);
    // A different address is still allowed (only the one real entry was added).
    expect(await screen.isAllowed("0x0000000000000000000000000000000000000009")).toBe(true);
  });
});
