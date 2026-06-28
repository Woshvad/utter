// Behavioral conformance suite for the REAL Postgres marketplace store adapter
// (apps/marketplace/src/stores/pg.ts -- PgIndexStore + PgCardStore), run fully
// OFFLINE against a hand-rolled faithful fake of the exact pg.Pool.query command
// surface the adapter calls. No real Postgres, no Docker, no new npm dependency.
//
// This mirrors services/facilitator/test/pg-redis-store.test.ts: the adapter's SQL
// (INSERT ... ON CONFLICT DO UPDATE, SELECT by id, SELECT all, UPDATE for delist),
// parameter order, and rows shape are actually EXECUTED here, asserting the SAME
// IndexStore / CardStore contract the in-memory adapters satisfy: upsert/get/list/
// delist, idempotent re-upsert, the bigint round-trip through jsonb (reputation, bond
// as decimal strings), card put/get + republish overwrite, and unknown id -> null.
//
// Money: reputation + bond stay decimal strings inside the jsonb payload at the
// boundary exactly as the adapter does, and are parsed back to bigint on read; never a
// JS number for a base-unit amount, never a decimals literal.
import { describe, it, expect, beforeEach } from "vitest";
import type { Pool } from "pg";
import { PgIndexStore, PgCardStore, createPgStores } from "../src/stores/pg";
import type { IndexRecord, Hex } from "../src/index-store";

// --------------------------------------------------------------------------- //
// FakePgPool: one async query(sql, params) method backed by two Maps keyed on   //
// resource_id (resources + cards). Matches the adapter's fixed SQL literals on   //
// substrings, honoring INSERT ... ON CONFLICT DO UPDATE, the jsonb payload round- //
// trip (it stores the PARSED payload, exactly as Postgres returns jsonb as an     //
// object), the delist UPDATE (active flip + jsonb_set), and SELECT by id / all.   //
// --------------------------------------------------------------------------- //

interface PayloadJson extends Omit<IndexRecord, "reputation" | "bond"> {
  reputation: string;
  bond: string;
}

interface ResourceRow {
  resource_id: string;
  active: boolean;
  payload: PayloadJson;
}

interface CardRow {
  resource_id: string;
  card: Record<string, unknown>;
}

class FakePgPool {
  private readonly resources = new Map<string, ResourceRow>();
  private readonly cards = new Map<string, CardRow>();

  // TEETH KNOB (test-only): when true, the resources INSERT ON CONFLICT IGNORES the
  // DO UPDATE and keeps the existing row instead of overwriting. Used to PROVE the
  // idempotent-re-upsert assertion reddens, then restored to false. NEVER a
  // production-logic change -- this is the fake's own knob.
  sabotageOnConflictIgnored = false;

  /** Test introspection: the raw stored resource row (post-jsonb-parse). */
  _resourceRow(resourceId: string): ResourceRow | undefined {
    return this.resources.get(resourceId);
  }

  async query<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    // resources INSERT ... ON CONFLICT (resource_id) DO UPDATE
    if (sql.includes("INSERT INTO resources")) {
      const [resourceId, active, payloadJson] = params as [string, boolean, string];
      const existing = this.resources.get(resourceId);
      // Postgres parses jsonb into a JS object on read; the fake mirrors that by
      // storing the PARSED payload, so get/list return objects (not strings).
      const parsed = JSON.parse(payloadJson) as PayloadJson;
      if (existing && this.sabotageOnConflictIgnored) {
        // TEETH: behave like ON CONFLICT DO NOTHING (the bug under test).
        return { rows: [] };
      }
      this.resources.set(resourceId, { resource_id: resourceId, active, payload: parsed });
      return { rows: [] };
    }

    // resources UPDATE ... SET active = false, payload = jsonb_set(...) WHERE resource_id
    if (sql.includes("UPDATE resources")) {
      const [resourceId] = params as [string];
      const row = this.resources.get(resourceId);
      // WHERE resource_id matches only an existing row -> unknown id is a no-op.
      if (row) {
        row.active = false;
        row.payload = { ...row.payload, active: false };
      }
      return { rows: [] };
    }

    // resources SELECT payload WHERE resource_id = $1
    if (sql.includes("SELECT payload FROM resources WHERE resource_id")) {
      const [resourceId] = params as [string];
      const row = this.resources.get(resourceId);
      return { rows: row ? ([{ payload: row.payload }] as unknown as T[]) : [] };
    }

    // resources SELECT payload (list all)
    if (sql.includes("SELECT payload FROM resources")) {
      const rows = [...this.resources.values()].map((r) => ({ payload: r.payload }));
      return { rows: rows as unknown as T[] };
    }

    // cards INSERT ... ON CONFLICT (resource_id) DO UPDATE
    if (sql.includes("INSERT INTO cards")) {
      const [resourceId, cardJson] = params as [string, string];
      const parsed = JSON.parse(cardJson) as Record<string, unknown>;
      this.cards.set(resourceId, { resource_id: resourceId, card: parsed });
      return { rows: [] };
    }

    // cards SELECT card WHERE resource_id = $1
    if (sql.includes("SELECT card FROM cards WHERE resource_id")) {
      const [resourceId] = params as [string];
      const row = this.cards.get(resourceId);
      return { rows: row ? ([{ card: row.card }] as unknown as T[]) : [] };
    }

    throw new Error(`FakePgPool.query: unmatched SQL: ${sql.slice(0, 48)}`);
  }
}

// --------------------------------------------------------------------------- //
// Test fixtures (bytes32 Hex resourceIds, mirroring the in-memory store tests).  //
// --------------------------------------------------------------------------- //

const RES_A: Hex = `0x${"a1".repeat(32)}`;
const RES_B: Hex = `0x${"b2".repeat(32)}`;

function makeRecord(overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    resourceId: RES_A,
    agentId: "42",
    slug: "weather-now",
    category: "data",
    pricing: { model: "escrow", base: "10000", perKB: "500", max: "50000" },
    // reputation + bond are bigint and round-trip as decimal strings through jsonb.
    reputation: 7n,
    uptime: 0.99,
    health: { verified: true, score: 0.99 },
    bond: 5_000_000n,
    cardUrl: "https://weather-now.resources.utter.app/.well-known/agent-card.json",
    active: true,
    ...overrides,
  };
}

function makeFakes() {
  const fakePg = new FakePgPool();
  const indexStore = new PgIndexStore(fakePg as unknown as Pool);
  const cardStore = new PgCardStore(fakePg as unknown as Pool);
  return { fakePg, indexStore, cardStore };
}

// --------------------------------------------------------------------------- //
// PgIndexStore conformance                                                      //
// --------------------------------------------------------------------------- //

describe("PgIndexStore (real adapter, hand-rolled pg fake)", () => {
  let fakePg: FakePgPool;
  let indexStore: PgIndexStore;

  beforeEach(() => {
    ({ fakePg, indexStore } = makeFakes());
  });

  it("upsert then get round-trips the full record (unknown id -> null first)", async () => {
    expect(await indexStore.get(RES_A)).toBeNull();
    const record = makeRecord();
    await indexStore.upsert(record);
    const got = await indexStore.get(RES_A);
    expect(got).toEqual(record);
  });

  it("reputation + bond round-trip as bigint through the jsonb decimal-string payload", async () => {
    // A value past Number.MAX_SAFE_INTEGER proves the decimal-string path (a JS number
    // would lose precision here).
    const bigBond = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    await indexStore.upsert(makeRecord({ reputation: 123n, bond: bigBond }));
    const got = await indexStore.get(RES_A);
    expect(typeof got?.reputation).toBe("bigint");
    expect(typeof got?.bond).toBe("bigint");
    expect(got?.reputation).toBe(123n);
    expect(got?.bond).toBe(bigBond);
    // The stored payload carries them as strings, not JS numbers.
    const stored = fakePg._resourceRow(RES_A);
    expect(stored?.payload.bond).toBe("9007199254740993");
    expect(typeof stored?.payload.reputation).toBe("string");
  });

  it("list returns every upserted record (reconstructed from jsonb)", async () => {
    await indexStore.upsert(makeRecord({ resourceId: RES_A }));
    await indexStore.upsert(makeRecord({ resourceId: RES_B, slug: "fx-rate" }));
    const all = await indexStore.list();
    expect(all).toHaveLength(2);
    const slugs = all.map((r) => r.slug).sort();
    expect(slugs).toEqual(["fx-rate", "weather-now"]);
    // bigint reconstruction holds across the list.
    for (const r of all) expect(typeof r.bond).toBe("bigint");
  });

  it("re-upsert is IDEMPOTENT (ON CONFLICT DO UPDATE): the second write overwrites, no duplicate", async () => {
    await indexStore.upsert(makeRecord({ reputation: 1n }));
    await indexStore.upsert(makeRecord({ reputation: 9n, slug: "weather-v2" }));
    const all = await indexStore.list();
    expect(all).toHaveLength(1);
    const got = await indexStore.get(RES_A);
    expect(got?.reputation).toBe(9n);
    expect(got?.slug).toBe("weather-v2");
  });

  it("delist flips active=false (top-level AND jsonb); get reconstructs active=false", async () => {
    await indexStore.upsert(makeRecord({ active: true }));
    await indexStore.delist(RES_A);
    const got = await indexStore.get(RES_A);
    expect(got?.active).toBe(false);
    expect(fakePg._resourceRow(RES_A)?.active).toBe(false);
  });

  it("delist of an UNKNOWN resource is an idempotent no-op (no throw, no row created)", async () => {
    await expect(indexStore.delist(RES_B)).resolves.toBeUndefined();
    expect(await indexStore.get(RES_B)).toBeNull();
    expect(await indexStore.list()).toHaveLength(0);
  });

  it("TEETH: with ON CONFLICT ignored, re-upsert does NOT overwrite (proves the suite reddens)", async () => {
    fakePg.sabotageOnConflictIgnored = true;
    try {
      await indexStore.upsert(makeRecord({ reputation: 1n }));
      await indexStore.upsert(makeRecord({ reputation: 9n, slug: "weather-v2" }));
      const got = await indexStore.get(RES_A);
      // With the conflict ignored the FIRST write survives -- the opposite of the
      // idempotent-overwrite contract. This asserts the teeth actually bite.
      expect(got?.reputation).toBe(1n);
      expect(got?.slug).toBe("weather-now");
    } finally {
      // Restore the knob: production logic is ON CONFLICT DO UPDATE.
      fakePg.sabotageOnConflictIgnored = false;
    }
  });
});

// --------------------------------------------------------------------------- //
// PgCardStore conformance                                                       //
// --------------------------------------------------------------------------- //

describe("PgCardStore (real adapter, hand-rolled pg fake)", () => {
  let cardStore: PgCardStore;

  beforeEach(() => {
    ({ cardStore } = makeFakes());
  });

  const card: Record<string, unknown> = {
    protocolVersion: "0.3.0",
    name: "weather-now",
    x402: { model: "escrow", base: "10000" },
  };

  it("put then get round-trips the finalized card; unknown id -> null", async () => {
    expect(await cardStore.get(RES_A)).toBeNull();
    await cardStore.put(RES_A, card);
    expect(await cardStore.get(RES_A)).toEqual(card);
  });

  it("a republish OVERWRITES the finalized card (ON CONFLICT DO UPDATE)", async () => {
    await cardStore.put(RES_A, card);
    const updated = { ...card, name: "weather-now-v2", x402: { model: "escrow", base: "20000" } };
    await cardStore.put(RES_A, updated);
    const got = await cardStore.get(RES_A);
    expect(got).toEqual(updated);
    expect((got as { name: string }).name).toBe("weather-now-v2");
  });
});

// --------------------------------------------------------------------------- //
// createPgStores wiring                                                          //
// --------------------------------------------------------------------------- //

describe("createPgStores", () => {
  it("constructs both stores over a single Pool from a databaseUrl (no real query)", async () => {
    // A non-routing host: new Pool() constructs lazily and connects only on the first
    // query, which this test never issues. end() releases the pool so there is no open
    // handle (the suite stays offline).
    const stores = createPgStores({
      databaseUrl: "postgres://user:pw@10.255.255.1:5432/utter",
    });
    try {
      expect(stores.indexStore).toBeInstanceOf(PgIndexStore);
      expect(stores.cardStore).toBeInstanceOf(PgCardStore);
    } finally {
      const pool = (stores.indexStore as unknown as { pg: { end: () => Promise<void> } }).pg;
      await pool.end();
    }
  });
});
