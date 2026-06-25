#!/bin/sh
# probe.sh - the blocked-host probe entrypoint.
#
# Given a target host as $1 (and an optional port as $2, default 80), attempt a
# short-timeout TCP connect with BusyBox netcat. Exit 0 if the host is REACHABLE
# (a containment FAILURE the caller must surface), non-zero if the connect is
# refused / times out (the blocked-OK outcome).
#
# This runs on the handler's pairnet (the host caller sets NetworkMode to the
# pairnet name - the same internal bridge, no gateway, so the same reachability
# as the handler), so the reachability it tests is the handler's real
# reachability, not this container's own.
set -eu

TARGET_HOST="${1:?probe.sh: missing target host (arg 1)}"
TARGET_PORT="${2:-80}"

# nc -z: zero-I/O scan (connect only, send nothing). -w2: 2-second connect
# timeout so an unreachable/dropped target fails fast instead of hanging. A
# successful connect exits 0 (reachable); a refused/timed-out connect exits
# non-zero (unreachable). Pass that exit code straight through.
exec nc -z -w2 "$TARGET_HOST" "$TARGET_PORT"
