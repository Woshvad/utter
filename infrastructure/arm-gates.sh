#!/usr/bin/env bash
# arm-gates.sh - one-shot, idempotent arming of the two operator-gated marketplace gates:
#   1. the Live-HTTPS publish probe (SCORER_LIVE_HTTPS_HOST)
#   2. the ERC-8004 identity mint (deploys the 3 reference registries, then wires them)
#
# It reuses your PLATFORM_TREASURY_PRIVATE_KEY as the REGISTRY_ADMIN_PRIVATE_KEY (one key
# for treasury + registry admin), writes every value into .env.local (gitignored), and
# recreates ONLY the marketplace container. Safe to re-run: existing values are updated in
# place and the registry deploy is skipped once the addresses are set.
#
# The private key is NEVER printed; only the derived public ADDRESS is echoed.
#
# Run on the host (root, in the repo):  cd /opt/utter && git pull && bash infrastructure/arm-gates.sh
set -euo pipefail

REPO="${UTTER_REPO:-/opt/utter}"
ENV_FILE="$REPO/.env.local"
COMPOSE="$REPO/infrastructure/docker-compose.yml"
DEFAULT_RPC="https://rpc.testnet.arc.network"
EXPLORER="https://testnet.arcscan.app"

say() { printf '[arm-gates] %s\n' "$*"; }
die() { printf '[arm-gates] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ]  || die "no $ENV_FILE (run from the repo root on the host)"
[ -f "$COMPOSE" ]   || die "no $COMPOSE - did you 'git pull' the compose env-passthrough change first?"
command -v docker >/dev/null 2>&1 || die "docker not found"

# The compose passthrough for these env vars must be present (it ships with this script).
grep -q 'SCORER_LIVE_HTTPS_HOST' "$COMPOSE" || die "compose is missing the gate env passthrough - 'git pull' the latest master first"

# --- upsert KEY=VALUE into .env.local (replace in place, else append). No secret echo. ---
upsert_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" '
    $0 ~ "^"k"=" { print k"="v; found=1; next }
    { print }
    END { if (!found) print k"="v }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}
# read a single value from .env.local (empty if unset). Greps ONE key - it NEVER sources
# the file: .env.local is dotenv format, not a bash script, so any value with a shell-
# special char (space, (), <, >, quotes, #) would break `source`. Strips a trailing CR
# (CRLF-edited files) and a single pair of surrounding quotes.
get_env() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Read only the values we need, WITHOUT sourcing .env.local (see get_env above).
PLATFORM_TREASURY_PRIVATE_KEY="$(get_env PLATFORM_TREASURY_PRIVATE_KEY)"
ARC_RPC_URL="$(get_env ARC_RPC_URL)"; ARC_RPC_URL="${ARC_RPC_URL:-$DEFAULT_RPC}"
DEPLOY_DOMAIN="$(get_env DEPLOY_DOMAIN)"

[ -n "$PLATFORM_TREASURY_PRIVATE_KEY" ] || \
  die "PLATFORM_TREASURY_PRIVATE_KEY is not set in .env.local (the treasury key you already swept with)."

# --- ensure foundry (forge + cast) is available; auto-install if missing ------------------
if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
  say "foundry (forge/cast) not found - installing…"
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1 || foundryup
  export PATH="$HOME/.foundry/bin:$PATH"
  command -v forge >/dev/null 2>&1 || die "forge still missing after install - install foundry manually (https://getfoundry.sh) and re-run"
fi

TREASURY_KEY="$PLATFORM_TREASURY_PRIVATE_KEY"
TREASURY_ADDR="$(cast wallet address --private-key "$TREASURY_KEY")"
say "treasury / registry-admin address: $TREASURY_ADDR"

# Safety: if a DIFFERENT REGISTRY_ADMIN_PRIVATE_KEY is already set, warn - overwriting it
# with the treasury key changes which address holds registry authority. The user asked for
# them to be the same, so we proceed, but surface the change so a mismatch is never silent.
CUR_ADMIN="$(get_env REGISTRY_ADMIN_PRIVATE_KEY)"
if [ -n "$CUR_ADMIN" ] && [ "$CUR_ADMIN" != "$TREASURY_KEY" ]; then
  CUR_ADMIN_ADDR="$(cast wallet address --private-key "$CUR_ADMIN" 2>/dev/null || echo '?')"
  if [ "$CUR_ADMIN_ADDR" != "$TREASURY_ADDR" ]; then
    say "WARNING: existing REGISTRY_ADMIN_PRIVATE_KEY resolves to $CUR_ADMIN_ADDR, replacing it with the"
    say "         treasury address $TREASURY_ADDR. If register/mint later reverts on an auth error, the"
    say "         deployed ResourceRegistry admin role must be granted to the treasury address."
  fi
fi

# --- 1) treasury key IS the registry admin ------------------------------------------------
upsert_env REGISTRY_ADMIN_PRIVATE_KEY "$TREASURY_KEY"
say "REGISTRY_ADMIN_PRIVATE_KEY set to the treasury key."

# --- 2) arm the Live-HTTPS publish probe --------------------------------------------------
# Derive the resources apex from DEPLOY_DOMAIN (resources.<domain>), else the known host.
if [ -n "${DEPLOY_DOMAIN:-}" ]; then
  case "$DEPLOY_DOMAIN" in
    resources.*) PROBE_HOST="$DEPLOY_DOMAIN" ;;
    *)           PROBE_HOST="resources.$DEPLOY_DOMAIN" ;;
  esac
else
  PROBE_HOST="resources.utter.technology"
fi
upsert_env SCORER_LIVE_HTTPS_HOST "$PROBE_HOST"
say "Live-HTTPS publish probe armed for *.$PROBE_HOST"

# --- 3) ERC-8004 registries: deploy once, then wire the addresses -------------------------
HAVE_ID="$(get_env ERC8004_IDENTITY_REGISTRY)"
HAVE_REP="$(get_env ERC8004_REPUTATION_REGISTRY)"
HAVE_VAL="$(get_env ERC8004_VALIDATION_REGISTRY)"
if [ -n "$HAVE_ID" ] && [ -n "$HAVE_REP" ] && [ -n "$HAVE_VAL" ]; then
  say "ERC-8004 registries already set (identity $HAVE_ID) - skipping deploy."
else
  say "deploying the 3 ERC-8004 reference registries to Arc testnet (broadcasts, costs gas)…"
  ( cd "$REPO/contracts" && forge build >/dev/null 2>&1 ) || {
    say "forge build failed - initializing contract submodules (forge-std)…"
    git -C "$REPO" submodule update --init --recursive || true
  }
  DEPLOY_OUT="$(cd "$REPO/contracts" && \
    REGISTRY_ADMIN_PRIVATE_KEY="$TREASURY_KEY" CONTRACT_OWNER="$TREASURY_ADDR" \
    forge script script/DeployErc8004.s.sol --rpc-url "$ARC_RPC_URL" --broadcast 2>&1)" || {
      echo "$DEPLOY_OUT"; die "ERC-8004 deploy failed (see forge output above)";
  }
  echo "$DEPLOY_OUT" | grep -iE 'Registry:' || true
  ID_ADDR="$(echo  "$DEPLOY_OUT" | grep -i 'IdentityRegistry'   | grep -oiE '0x[0-9a-fA-F]{40}' | head -1)"
  REP_ADDR="$(echo "$DEPLOY_OUT" | grep -i 'ReputationRegistry' | grep -oiE '0x[0-9a-fA-F]{40}' | head -1)"
  VAL_ADDR="$(echo "$DEPLOY_OUT" | grep -i 'ValidationRegistry' | grep -oiE '0x[0-9a-fA-F]{40}' | head -1)"
  [ -n "$ID_ADDR" ] && [ -n "$REP_ADDR" ] && [ -n "$VAL_ADDR" ] || \
    die "could not parse the 3 registry addresses from the deploy output"
  upsert_env ERC8004_IDENTITY_REGISTRY   "$ID_ADDR"
  upsert_env ERC8004_REPUTATION_REGISTRY "$REP_ADDR"
  upsert_env ERC8004_VALIDATION_REGISTRY "$VAL_ADDR"
  say "ERC-8004 registries deployed + wired:"
  say "  identity   $ID_ADDR"
  say "  reputation $REP_ADDR"
  say "  validation $VAL_ADDR"
fi

# --- 4) recreate the marketplace so it picks up the new env -------------------------------
say "recreating the marketplace container with the new env…"
( cd "$REPO" && docker compose -f "$COMPOSE" --env-file "$ENV_FILE" up -d marketplace )

# --- summary ------------------------------------------------------------------------------
say "done. both gates are armed:"
say "  publish probe : *.$PROBE_HOST  (a publish now runs a no-pay card+402 liveness probe)"
say "  erc-8004 mint : registry admin = treasury ($TREASURY_ADDR); next publish mints a real agentId"
say "verify:  docker compose -f $COMPOSE ps   # marketplace healthy"
say "         then publish a resource from the studio and watch the marketplace logs for the probe + mint."
say "         registry txs: $EXPLORER/address/$TREASURY_ADDR"
