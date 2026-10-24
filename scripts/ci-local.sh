#!/bin/sh
# Runs what .github/workflows/tests.yml runs, against the database in
# DATABASE_URL, which must be an empty, disposable one with "test" in its name.
# Starts its own server on PORT (3137 by default) and stops it at the end.
# usage: DATABASE_URL=postgres://<user>@localhost:5432/xitter_test sh scripts/ci-local.sh
set -u
cd "$(dirname "$0")/.." || exit 1

case "${DATABASE_URL:-}" in
	*test*) ;;
	*) echo "Set DATABASE_URL to a throwaway database with \"test\" in its name." >&2; exit 1 ;;
esac
export PORT="${PORT:-3137}" RATE_LIMITS=off RESEND_API_KEY= SMTP_URL= KLIPY_API_KEY=
export TEST_ORIGIN="http://localhost:$PORT" MEDIA_DIR="${MEDIA_DIR:-.ci-media}"
mkdir -p "$MEDIA_DIR"

failed=0
passed=0
run() {
	if out=$(eval "$1" 2>&1); then
		passed=$((passed + 1))
		echo "ok   $1"
	else
		failed=$((failed + 1))
		echo "FAIL $1"
		echo "$out" | tail -15 | sed 's/^/     /'
	fi
}
# the workflow's own lines, so this list can't drift from it
steps() { awk "/name: $1/{f=1;next} /- name:/{f=0} f" .github/workflows/tests.yml | grep -E '^ +([A-Z_]+=[^ ]+ )*bun (scripts/|-e )' | sed 's/^ *//'; }

run "bun run test:unit"
run "bun -e 'import { migrate, sql } from \"./src/db\"; await migrate(); await sql.close();'"
steps "Database regression tests" > .ci-steps
steps "Media privacy" >> .ci-steps
while IFS= read -r line; do run "$line"; done < .ci-steps

bun src/server.ts > .ci-server.log 2>&1 &
server=$!
for _ in $(seq 1 60); do
	curl -sf "$TEST_ORIGIN/account/forgot" > /dev/null && break
	sleep 1
done
steps "HTTP and encrypted chat" > .ci-steps
while IFS= read -r line; do run "$line"; done < .ci-steps
kill "$server" 2>/dev/null
wait "$server" 2>/dev/null

rm -rf .ci-steps .ci-server.log "$MEDIA_DIR"
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
