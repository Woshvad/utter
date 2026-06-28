# Utter provisioning + ops hardening runbook

How to bring up the durable backends (Postgres + Redis), arm durability, supervise the
host deployer, and lift the "logic-verified, not live-infra-verified" flag on the store
adapters. This is the operator-gated, host-only counterpart to the code that landed in the
provisioning track.

This builds on `infrastructure/sandbox-host/PROVISION.md` (the gVisor / TLS / nftables host
checklist) and `infrastructure/RUNBOOK.md` (the compose stack + the studio deploy). Run the
sandbox-host checklist first; this does not replace it. Every secret lives only in
`/opt/utter/.env.local` (gitignored). This document never prints a key.

## 0. What the code already provides

The provisioning track wired durability so it is OPT-IN and fails closed in production:

- `infrastructure/db/schema.sql` is the canonical schema for all seven durable tables
  (payments, results, revenue for the facilitator; resources, cards, moderation_decisions,
  moderation_reviews for the marketplace). The deployer is Redis-only and has no tables.
- `infrastructure/docker-compose.yml` has a `postgres:16` service on the internal `backendnet`
  network (no published port) that loads `db/schema.sql` once on first boot, plus a `pgdata`
  named volume. The facilitator is on `redisnet` + `backendnet`; the marketplace is on
  `backendnet`; both gate on `postgres` being healthy.
- Each durable service has a `/ready` probe (pg `SELECT 1`, redis `PING`) and a Docker
  HEALTHCHECK; the studio waits for the facilitator + marketplace to be healthy before it
  starts. `/health` stays a constant liveness check.
- The facilitator buyer lock and spend cap, the facilitator pg/redis stores, the marketplace
  pg stores, and the deployer redis stores all switch to durable backends when their URL is
  set and throw at boot in production when it is missing.

With `NODE_ENV` unset and no URLs, everything stays in memory, so a plain `docker compose up`
and the autonomous test suite need no infrastructure. Setting `NODE_ENV=production` is what
arms the fail-closed durable path.

## 1. Provision the durable engines

### 1.1 Postgres (marketplace + facilitator)

1. In `/opt/utter/.env.local` set `POSTGRES_USER`, `POSTGRES_PASSWORD` (non-empty; postgres:16
   refuses an empty password, which is the desired fail-loud), `POSTGRES_DB`, and
   `DATABASE_URL=postgres://<user>:<password>@postgres:5432/<db>` (the `postgres` service
   hostname on `backendnet`).
2. Bring it up: `docker compose -f infrastructure/docker-compose.yml --env-file .env.local up -d postgres`.
3. Verify: the healthcheck reports healthy (`docker compose ps`), and the schema loaded:
   `docker compose exec postgres psql -U <user> -d <db> -c '\dt'` lists all seven tables.
4. Schema changes: `db/schema.sql` runs ONLY on a fresh/empty `pgdata` volume (the postgres
   init behavior). To re-apply after editing it, stop the stack and drop the volume on the host
   (`docker volume rm <project>_pgdata`), then bring postgres back up. There are no live
   migrations from the mount.

### 1.2 Redis

The compose `redis` service runs on `redisnet`, reachable by the facilitator (now on `redisnet`)
and the data-proxy with no published host port. The HOST deployer process is NOT in compose, so
it cannot reach `redis://redis:6379`. Choose one, and set `REDIS_URL` in `.env.local` to match:

- Loopback publish (minimal): publish redis on `127.0.0.1:6379` only and set the deployer's
  `REDIS_URL=redis://127.0.0.1:6379`. Loopback keeps it off the public internet but does widen
  reachability beyond `redisnet`, so weigh it against your host posture.
- Host-local redis: run a separate redis on the host for the deployer and point `REDIS_URL` at it.

The in-compose facilitator keeps its default `REDIS_URL=redis://redis:6379` over `redisnet`; an
explicit `.env.local` value still wins.

## 2. Arm durability

In `/opt/utter/.env.local` set `NODE_ENV=production` together with the URLs from section 1
(`DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`). Setting `NODE_ENV=production` without the URLs
makes the facilitator/marketplace throw at boot (the intended fail-closed). Then:

```
docker compose -f infrastructure/docker-compose.yml --env-file .env.local up -d --build
```

Verify readiness: `/ready` returns 200 on the facilitator and the marketplace once their stores
are reachable (the compose healthchecks read this, and the studio waits on them). A `/ready` 503
means a backend is unreachable; `/health` stays 200 (liveness) regardless.

## 3. Install and supervise the host deployer

The deployer is a bare host process (it needs the host Docker daemon + runsc), supervised by
systemd so it restarts on crash and logs to journald.

1. Create the service account: a `utter` user in the `docker` group, owning `/opt/utter`.
2. Confirm `/opt/utter/.env.local` carries the deployer secrets: `DEPLOYER_AUTH_SECRET` (the
   Bearer for POST /deploy; 503 without it), `REDIS_URL` (durable deployment records; throws at
   boot without it in production), and the chain/deploy keys the live deploy needs
   (`RELAYER_SIGNER_KEYS`, `REGISTRY_ADMIN_PRIVATE_KEY`, `PLATFORM_TREASURY`, `ARC_RPC_URL`,
   `DEPLOY_DOMAIN`, `DEPLOY_BASE_IMAGE_NODE`).
3. Install the unit: copy `infrastructure/systemd/utter-deployer.service` to
   `/etc/systemd/system/`, set the absolute node path in `ExecStart` to the host's node, then
   `systemctl daemon-reload` and `systemctl enable --now utter-deployer`.
4. Verify: `curl -s http://127.0.0.1:8788/health` is `{"ok":true,"service":"deployer"}`,
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/ready` is `200`, and the journal
   shows the reconcile loop started: `journalctl -u utter-deployer -n 50`.
5. Restart proof: `systemctl kill utter-deployer`; confirm `Restart=always` brings it back within
   `RestartSec` and `/health` recovers, so the studio Deploy step no longer hits "fetch failed".
6. Firewall: keep `:8788` off the public internet; only the docker bridge subnet needs it (the
   studio reaches it over `host.docker.internal`).

## 4. New ops environment reference

Set these in `/opt/utter/.env.local` (durability + secrets) or as unit `Environment=` (the
deployer's non-secret config). None has a baked default secret.

- `NODE_ENV=production` arms the fail-closed durable path across the facilitator, marketplace,
  and deployer.
- `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` for Postgres.
- `REDIS_URL` for the facilitator (in-compose default) and the host deployer (section 1.2).
- `SHUTDOWN_DRAIN_MS` (default 10000): the graceful-shutdown drain window. The container or
  systemd stop grace MUST exceed it so the drain finishes before SIGKILL (`docker stop -t 15`,
  the unit's `TimeoutStopSec=30`).
- `DEPLOY_TIMEOUT_MS` (default 600000): a deploying record older than this is quarantined to
  failed by the reconcile loop so its partial containers are reaped (crash recovery).
- `ALERT_WEBHOOK_URL` (empty = no-op): a best-effort POST sink for security-relevant reconcile
  events (reap failure, runaway quarantine, capacity defer, deploy-timeout). Events always go to
  the structured JSON logs regardless. Never put credentials in the URL.

## 5. Live conformance acceptance (lift the honesty flag)

The store adapters carry a "logic-verified, not live-infra-verified" header because their SQL and
Lua are proven offline against faithful fakes, never against a real engine.

- Step A (offline, already green): the faithful-fake conformance suites EXECUTE the adapter
  command logic with no engine. Run `pnpm -C apps/marketplace test`, `pnpm -C services/facilitator
  test`, `pnpm -C services/deployer test`.
- Step B (one-time, against the provisioned engines): with `DATABASE_URL` / `REDIS_URL` pointed at
  the real Postgres/Redis from sections 1 and 2, run one round-trip per store class against the
  live engines (resources + cards upsert/get/list/delist; payments reserve/release/markNonceSpent;
  results put/get; revenue record/byResource; the deployer deployment-record put + slug claim;
  the buyer-lock acquire/release; the spend-cap record/refund) to confirm the live schema and
  engine match the adapter contract.
- On a clean pass, flip each adapter header from "logic-verified, not live-infra-verified" to
  live-verified, mirroring how the RUNBOOK flips Deferred Items to Verified after a host proof.

## 6. Operate

- Logs: `journalctl -u utter-deployer -f` (journald is the deployer's log rotation). Compose
  services: `docker compose -f infrastructure/docker-compose.yml logs -f <service>`.
- Restart / disable the deployer: `systemctl restart utter-deployer`, `systemctl disable --now
  utter-deployer`.
- Upgrade: `git pull && pnpm install && docker compose ... up -d --build && systemctl restart
  utter-deployer`. A schema change additionally requires the drop-pgdata step in section 1.1.
