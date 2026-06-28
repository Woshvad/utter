// resolveMarketplaceStores: env-driven store selection with production fail-closed on
// durability. Mirrors the deployer's resolve-stores test discipline.
//
// DATABASE_URL set + non-empty -> the durable Postgres-backed adapters (assert by the
// store class, WITHOUT issuing a real query). NODE_ENV=production + no DATABASE_URL ->
// THROW at boot (never silently ephemeral in prod). Dev/test + no DATABASE_URL ->
// in-memory (the autonomous suite needs no Postgres).
//
// No real Postgres traffic: when DATABASE_URL is set, createPgStores constructs a pg
// Pool that connects lazily on the first query. We never issue a query, and we end()
// the pool at the end of the test so there is no open handle (the URL points at a
// non-routing host).
import { describe, it, expect } from "vitest";
import { resolveMarketplaceStores } from "../src/server";
import { PgIndexStore, PgCardStore, PgModerationStore } from "../src/stores/pg";
import { InMemoryIndexStore } from "../src/index-store";
import { InMemoryCardStore } from "../src/card-store";
import { InMemoryModerationStore } from "../src/moderation/review-queue";

/** A private-range host that does not route, so no connection ever establishes. */
const NON_ROUTING_DATABASE_URL = "postgres://user:pw@10.255.255.1:5432/utter";

describe("resolveMarketplaceStores (env-driven selection, prod fail-closed)", () => {
  it("DATABASE_URL set -> the durable Postgres-backed adapters (no real query issued)", async () => {
    const stores = resolveMarketplaceStores({
      DATABASE_URL: NON_ROUTING_DATABASE_URL,
    } as NodeJS.ProcessEnv);
    try {
      expect(stores.indexStore).toBeInstanceOf(PgIndexStore);
      expect(stores.cardStore).toBeInstanceOf(PgCardStore);
      expect(stores.moderationStore).toBeInstanceOf(PgModerationStore);
    } finally {
      // All three stores share ONE Pool; end() it so there is no open handle.
      const pool = (stores.indexStore as unknown as { pg: { end: () => Promise<void> } }).pg;
      await pool.end();
    }
  });

  it("NODE_ENV=production + no DATABASE_URL -> throws (fail-closed on durability)", () => {
    expect(() =>
      resolveMarketplaceStores({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL must be set in production/);
  });

  it("a blank DATABASE_URL in production still throws (whitespace is not a value)", () => {
    expect(() =>
      resolveMarketplaceStores({
        NODE_ENV: "production",
        DATABASE_URL: "   ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL must be set in production/);
  });

  it("dev/test + no DATABASE_URL -> the in-memory defaults", () => {
    const stores = resolveMarketplaceStores({} as NodeJS.ProcessEnv);
    expect(stores.indexStore).toBeInstanceOf(InMemoryIndexStore);
    expect(stores.cardStore).toBeInstanceOf(InMemoryCardStore);
    expect(stores.moderationStore).toBeInstanceOf(InMemoryModerationStore);
  });

  it("the production throw never echoes the (missing/blank) DATABASE_URL value", () => {
    try {
      resolveMarketplaceStores({
        NODE_ENV: "production",
        DATABASE_URL: "   ",
      } as NodeJS.ProcessEnv);
      throw new Error("expected a throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The error is value-free: it names the env var, never its (blank) contents.
      expect(msg).not.toContain("   ");
      expect(msg).toContain("DATABASE_URL");
    }
  });
});
