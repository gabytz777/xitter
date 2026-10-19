#!/bin/sh
set -eu

# docker/env.sh generates a hex password; reject syntax that could alter the
# PgBouncer configuration or authentication file.
case "${POSTGRES_PASSWORD:-}" in
  ''|*[!a-zA-Z0-9_]* ) echo "POSTGRES_PASSWORD must contain only letters, digits, or underscores for PgBouncer" >&2; exit 1 ;;
esac
case "${POOL_SIZE:-20}" in
  ''|*[!0-9]* ) echo "POOL_SIZE must be a positive integer" >&2; exit 1 ;;
esac
if [ "${POOL_SIZE:-20}" -lt 1 ]; then echo "POOL_SIZE must be positive" >&2; exit 1; fi

cat > /tmp/pgbouncer.ini <<EOF
[databases]
xitter = host=db port=5432 dbname=xitter user=xitter password=${POSTGRES_PASSWORD}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /tmp/pgbouncer-users.txt
pool_mode = session
default_pool_size = ${POOL_SIZE:-20}
max_client_conn = 200
log_connections = 0
log_disconnections = 0
EOF
printf '"xitter" "%s"\n' "$POSTGRES_PASSWORD" > /tmp/pgbouncer-users.txt
chmod 600 /tmp/pgbouncer.ini /tmp/pgbouncer-users.txt
exec pgbouncer /tmp/pgbouncer.ini
