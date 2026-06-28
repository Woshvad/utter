// The real Postgres store adapter for the marketplace index + finalized cards
// (MKT-01/02).
//
// HONESTY FLAG: this adapter's COMMAND LOGIC is verified by a faithful-fake
// conformance suite (apps/marketplace/test/pg-store.test.ts) that EXECUTES
// PgIndexStore + PgCardStore offline against a hand-rolled pg.Pool fake, asserting
// the SAME IndexStore / CardStore contract the in-memory adapters satisfy: upsert
// idempotency via INSERT ... ON CONFLICT DO UPDATE, get/list reconstruction, the
// delist flip, card put/get + republish overwrite, and the bigint round-trip through
// jsonb. That suite runs in the default test run and needs no Docker/Postgres. It is
// STILL NOT verified against LIVE Postgres; live behavior is confirmed only when that
// service is provisioned (operator-gated Phase 3+ infra). Logic-verified, not
// live-infra-verified.
//
// Read-through trust is unchanged from the in-memory adapters: the index authors no
// money/identity value (T-05-06-INDEXTRUST) and the card route still re-validates
// before serving. All amounts (reputation feedbackCount, bond base units) are stored
// as DECIMAL STRINGS inside the jsonb payload and parsed back to bigint at the
// boundary, never a JS number (no precision loss), never a decimals literal.
//
// Parameterized queries only (never string-concatenated SQL). The connection string
// (DATABASE_URL, which may carry credentials) is held by the pg Pool and is never
// logged here.
import { Pool } from "pg";
import type { IndexStore, IndexRecord, Hex } from "../index-store.js";
import type { CardStore } from "../card-store.js";

// The jsonb payload shape: the full IndexRecord with its two bigint fields carried as
// decimal strings (reputation, bond). Everything else is JSON-native already.
interface PayloadJson extends Omit<IndexRecord, "reputation" | "bond"> {
  reputation: string;
  bond: string;
}

/** Serialize an IndexRecord into its jsonb payload (bigint fields -> decimal strings). */
function toPayload(record: IndexRecord): PayloadJson {
  const { reputation, bond, ...rest } = record;
  return { ...rest, reputation: reputation.toString(), bond: bond.toString() };
}

/** Reconstruct an IndexRecord from its jsonb payload (decimal strings -> bigint). */
function fromPayload(payload: PayloadJson): IndexRecord {
  const { reputation, bond, ...rest } = payload;
  return { ...rest, reputation: BigInt(reputation), bond: BigInt(bond) };
}

/**
 * Postgres-backed IndexStore over the `resources` table:
 *   resource_id text PRIMARY KEY, active boolean NOT NULL, payload jsonb NOT NULL.
 * The full IndexRecord lives in payload (bigint fields as decimal strings); the
 * top-level active column mirrors payload.active so delist is a single UPDATE and a
 * future SQL filter can read active without parsing the jsonb. Implements the SAME
 * IndexStore contract the in-memory adapter satisfies, so callers swap by env.
 */
export class PgIndexStore implements IndexStore {
  private readonly pg: Pool;

  constructor(pg: Pool) {
    this.pg = pg;
  }

  async upsert(record: IndexRecord): Promise<void> {
    // Idempotent insert: a re-upsert of the same resourceId overwrites the projected
    // row (the index mirrors its canonical sources; a later upsert is the refresh).
    await this.pg.query(
      `INSERT INTO resources (resource_id, active, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (resource_id) DO UPDATE
         SET active = EXCLUDED.active, payload = EXCLUDED.payload`,
      [record.resourceId, record.active, JSON.stringify(toPayload(record))],
    );
  }

  async get(resourceId: Hex): Promise<IndexRecord | null> {
    const { rows } = await this.pg.query<{ payload: PayloadJson }>(
      `SELECT payload FROM resources WHERE resource_id = $1`,
      [resourceId],
    );
    const row = rows[0];
    if (!row) return null;
    return fromPayload(row.payload);
  }

  async list(): Promise<IndexRecord[]> {
    const { rows } = await this.pg.query<{ payload: PayloadJson }>(
      `SELECT payload FROM resources`,
    );
    return rows.map((r) => fromPayload(r.payload));
  }

  async delist(resourceId: Hex): Promise<void> {
    // Flip active=false in BOTH the top-level column and the jsonb payload so a
    // subsequent get reconstructs active=false. WHERE resource_id matches only an
    // existing row, so an unknown resource is an idempotent no-op (0 rows updated).
    await this.pg.query(
      `UPDATE resources
         SET active = false,
             payload = jsonb_set(payload, '{active}', 'false')
       WHERE resource_id = $1`,
      [resourceId],
    );
  }
}

/**
 * Postgres-backed CardStore over the `cards` table:
 *   resource_id text PRIMARY KEY, card jsonb NOT NULL.
 * Holds the finalized, validateAgentCard-valid card the route serves. Implements the
 * SAME CardStore contract the in-memory adapter satisfies, so callers swap by env.
 */
export class PgCardStore implements CardStore {
  private readonly pg: Pool;

  constructor(pg: Pool) {
    this.pg = pg;
  }

  async put(resourceId: Hex, card: Record<string, unknown>): Promise<void> {
    // A republish overwrites the finalized card (ON CONFLICT DO UPDATE).
    await this.pg.query(
      `INSERT INTO cards (resource_id, card)
       VALUES ($1, $2)
       ON CONFLICT (resource_id) DO UPDATE SET card = EXCLUDED.card`,
      [resourceId, JSON.stringify(card)],
    );
  }

  async get(resourceId: Hex): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pg.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM cards WHERE resource_id = $1`,
      [resourceId],
    );
    const row = rows[0];
    return row ? row.card : null;
  }
}

/** Options for wiring the pg marketplace stores from env (DATABASE_URL). */
export interface PgStoresOptions {
  databaseUrl: string;
}

/**
 * Build the real pg-backed marketplace stores. Both the index and card store share
 * ONE Pool. Exposes the same { indexStore, cardStore } shape the in-memory default
 * does, so server.ts swaps adapters by env without touching route logic.
 * Behavior-unverified against live Postgres (see file header).
 */
export function createPgStores(opts: PgStoresOptions): {
  indexStore: PgIndexStore;
  cardStore: PgCardStore;
} {
  const pg = new Pool({ connectionString: opts.databaseUrl });
  return {
    indexStore: new PgIndexStore(pg),
    cardStore: new PgCardStore(pg),
  };
}
