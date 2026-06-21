// Scaffold smoke test for @utter/treasury (Wave 0). Asserts the member resolves
// and that the newly pinned CCTP_TOKEN_MINTER (and EURC) are importable through
// the member graph, with CCTP_TOKEN_MINTER equal to the authoritative address and
// CCTP_DOMAIN equal to the pinned 26. The SCL-03/04 feature plan replaces this
// with real PayoutRouter / StableFxAdapter / CctpFunder tests. Import-only: no
// network, chain, or attestation service is touched.
import { describe, it, expect } from "vitest";
import { CCTP_TOKEN_MINTER, CCTP_DOMAIN, EURC } from "@utter/chain";
import * as treasury from "../src/index";

describe("@utter/treasury scaffold", () => {
  it("imports the member barrel", () => {
    expect(treasury).toBeDefined();
  });

  it("resolves the pinned CCTP_TOKEN_MINTER through the member graph", () => {
    expect(CCTP_TOKEN_MINTER).toBe("0xb43db544E2c27092c107639Ad201b3dEfAbcF192");
  });

  it("pins the Arc CCTP destination domain to 26 (never the wrong 7)", () => {
    expect(CCTP_DOMAIN).toBe(26);
  });

  it("resolves EURC (the optional payout asset) through the member graph", () => {
    expect(EURC).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
