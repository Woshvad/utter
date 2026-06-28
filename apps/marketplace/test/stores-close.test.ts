// stores-close.test.ts - the per-service teardown DoD for the marketplace
// (Provisioning track, subtask 3).
//
// Asserts the close() seam createPgStores returns drains the single shared pg pool
// (pg.end), and that resolveMarketplaceStores threads close through for the Postgres
// branch but leaves it undefined for the in-memory branch (so graceful shutdown skips it
// and dev/test boot is byte-unchanged).
//
// OFFLINE: the factory constructs a real pg.Pool against a NON-ROUTABLE URL, but no real
// connection is ever made. We spy on Pool.prototype.end so close() is observed WITHOUT
// touching live infra; the spy resolves immediately so the worker leaves no open handle.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Pool } from "pg";
import { createPgStores } from "../src/stores/pg";
import { resolveMarketplaceStores } from "../src/server";

const FAKE_PG = "postgresql://u:p@127.0.0.1:1/db";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marketplace createPgStores().close()", () => {
  it("drains the shared pg pool (pg.end)", async () => {
    const endSpy = vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);

    const stores = createPgStores({ databaseUrl: FAKE_PG });
    expect(typeof stores.close).toBe("function");
    await stores.close();

    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});

describe("marketplace resolveMarketplaceStores close threading", () => {
  it("threads close for the Postgres branch", async () => {
    vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);
    const resolved = resolveMarketplaceStores({ DATABASE_URL: FAKE_PG } as NodeJS.ProcessEnv);
    expect(typeof resolved.close).toBe("function");
  });

  it("leaves close undefined for the in-memory branch (dev/test boot byte-unchanged)", () => {
    const resolved = resolveMarketplaceStores({} as NodeJS.ProcessEnv);
    expect(resolved.close).toBeUndefined();
  });
});
