-- Utter durable Postgres schema. Loaded ONCE by postgres:16 on first boot via
-- /docker-entrypoint-initdb.d (only when the data volume is empty). A schema change
-- requires dropping the pgdata volume on the operator host; there are no live
-- migrations from this mount. Every CREATE uses IF NOT EXISTS so a re-apply is
-- idempotent. Columns match exactly what the pg adapters query
-- (services/facilitator/src/stores/pgRedis.ts, apps/marketplace/src/stores/pg.ts).
-- MONEY DISCIPLINE: every USDC amount is text (base-unit decimal string, BigInt at the
-- boundary), never float/numeric-scaled, never a decimals literal. ts columns are bigint
-- ms-epoch (not money). The deployer is Redis-only and has NO tables here.

-- ===== Facilitator (pgRedis.ts) =====

CREATE TABLE IF NOT EXISTS payments (
  idem_key    text        NOT NULL,
  buyer       text        NOT NULL,
  resource_id text        NOT NULL,
  cap         text        NOT NULL,
  status      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_pkey PRIMARY KEY (idem_key)
);

CREATE TABLE IF NOT EXISTS results (
  idem_key   text        PRIMARY KEY,
  response   text        NOT NULL,
  receipt    jsonb       NOT NULL,
  stored_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue (
  idem_key       text        NOT NULL PRIMARY KEY,
  resource_id    text        NOT NULL,
  kind           text        NOT NULL,
  amount         text        NOT NULL,
  creator_share  text        NOT NULL,
  platform_share text        NOT NULL,
  tx             text        NOT NULL,
  seq            bigserial   NOT NULL,
  recorded_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS revenue_resource_id_seq_idx ON revenue (resource_id, seq);

-- ===== Marketplace (pg.ts) =====

CREATE TABLE IF NOT EXISTS resources (
  resource_id text    PRIMARY KEY,
  active      boolean NOT NULL,
  payload     jsonb   NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  resource_id text  PRIMARY KEY,
  card        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_decisions (
  seq         bigserial   PRIMARY KEY,
  resource_id text        NOT NULL,
  decision    text        NOT NULL,
  reason      text        NOT NULL,
  ts          bigint      NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_reviews (
  seq         bigserial PRIMARY KEY,
  resource_id text   NOT NULL,
  prompt      text   NOT NULL,
  reason      text   NOT NULL,
  ts          bigint NOT NULL
);
