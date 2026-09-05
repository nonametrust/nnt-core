#!/usr/bin/env bash
# A Postgres cluster that belongs to this repository and to no machine.
#
# It listens on loopback TCP only, with no Unix socket, and that is not a
# preference: a socket path may not exceed 103 bytes, and a socket directory
# inside a checkout under a long path exceeds it and fails at connect time with
# an error that reads like a permissions problem. Rather than put the socket
# somewhere outside the checkout, the cluster has none.
#
# The locale is C so the cluster's own default collation is deterministic. The
# explicit COLLATE "C" in the migrations stays regardless; the column must not
# depend on how the cluster was initialised.
set -euo pipefail

PORT="${NNT_DEV_DB_PORT:-55432}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$HERE/../.pgdata"
LOG="$HERE/../.pgdata.log"
PGBIN="${NNT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
export PATH="$PGBIN:$PATH"

case "${1:-up}" in
  up)
    if [ ! -d "$PGDATA" ]; then
      initdb -D "$PGDATA" -A trust -U nnt --encoding=UTF8 --locale=C >/dev/null
    fi
    if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA" -l "$LOG" \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
    fi
    createdb -h 127.0.0.1 -p "$PORT" -U nnt nnt_test 2>/dev/null || true
    echo "export NNT_TEST_DATABASE_URL=postgres://nnt@127.0.0.1:$PORT/nnt_test"
    ;;
  down)
    pg_ctl -D "$PGDATA" stop >/dev/null 2>&1 || true
    ;;
  destroy)
    pg_ctl -D "$PGDATA" stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA" "$LOG"
    ;;
  *)
    echo "usage: dev-db.sh [up|down|destroy]" >&2
    exit 2
    ;;
esac
