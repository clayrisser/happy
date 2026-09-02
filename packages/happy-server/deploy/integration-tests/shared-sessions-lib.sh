#!/bin/sh
# deploy/integration-tests/shared-sessions-lib.sh — the relay-under-test
# harness shared by shared-sessions.bats, managed-only.bats and
# private-default.bats (DROVE-388).
#
# Sourced by each suite. Brings ONE relay up FROM SOURCE on a free port
# against a throwaway Postgres container, with ACCOUNT_REGISTRATION=guest and
# the owner's fixture signing key pinned. Two knobs pick what the relay can
# do (decision 0c: a relay has capabilities, not a mode):
#   RELAY_ESCROW_UNDER_TEST=1   mint a throwaway escrow seed and give it to
#                               the relay, so it CAN manage sessions; the
#                               seed is kept so the suite can check what the
#                               relay announces and open what the CLI escrows
#   RELAY_SHARING_UNDER_TEST=on|off   passed through as RELAY_SHARING; unset
#                               means the variable is not set at all, which
#                               is how a relay nobody configured comes up
# Never touches ~/.happy: the CLI home is under the test's state dir and
# shared-sessions.mjs refuses any other. Every key is minted by the test and
# thrown away with the state dir.

free_port() {
    node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})'
}

random_hex() {
    node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"
}

setup_file() {
    FORK_DIR=${FORK_DIR:-$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)}
    SERVER_DIR="$FORK_DIR/packages/happy-server"
    STATE=${SHARED_SESSIONS_STATE_DIR:-${TMPDIR:-/tmp}/shared-sessions-test}
    export FORK_DIR SERVER_DIR STATE
    rm -rf "$STATE"
    umask 077
    mkdir -p "$STATE/happy-home" "$STATE/state" "$STATE/data"

    PG_PORT=$(free_port)
    RELAY_PORT=$(free_port)
    PG_PASSWORD=$(random_hex 16)
    PG_NAME="shared-sessions-pg-$(random_hex 4)"
    RELAY_URL="http://127.0.0.1:$RELAY_PORT"
    DATABASE_URL="postgresql://relay:$PG_PASSWORD@127.0.0.1:$PG_PORT/relay"
    printf '%s\n' "$PG_NAME" >"$STATE/pg-name"
    printf '%s\n' "$RELAY_URL" >"$STATE/url"
    printf '%s\n' "$DATABASE_URL" >"$STATE/database-url"
    printf '%s\n' "shared-sessions-fixture-$(random_hex 8)" >"$STATE/fixture"

    docker run -d --rm --name "$PG_NAME" \
        -e POSTGRES_USER=relay -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=relay \
        -p "127.0.0.1:$PG_PORT:5432" \
        "${SHARED_SESSIONS_POSTGRES_IMAGE:-postgres:16.10-alpine}" >/dev/null
    i=0
    until docker exec "$PG_NAME" pg_isready -U relay -d relay >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -gt 60 ]; then
            echo "postgres did not become ready" >&2
            exit 1
        fi
        sleep 1
    done

    (cd "$SERVER_DIR" && DATABASE_URL="$DATABASE_URL" ../../node_modules/.bin/prisma migrate deploy >"$STATE/migrate.log" 2>&1) || {
        cat "$STATE/migrate.log" >&2
        exit 1
    }

    # The relay's escrow box secret key comes from the operator; here the
    # test is the operator and mints a throwaway seed.
    escrow_seed=""
    if [ -n "${RELAY_ESCROW_UNDER_TEST:-}" ]; then
        escrow_seed=$(random_hex 32)
        printf '%s\n' "$escrow_seed" >"$STATE/escrow-seed"
    fi

    # The owner's signing key must be pinned BEFORE the relay starts, so the
    # fixture keys are minted first. Nothing has talked to the relay yet.
    keygen=$(client keygen)
    owner_hex=$(printf '%s' "$keygen" | jq -r .ownerSignPublicKeyHex)
    [ -n "$owner_hex" ] || {
        echo "keygen did not report the owner's signing key: $keygen" >&2
        exit 1
    }

    # Only the variables the suite set reach the relay: an empty
    # RELAY_SHARING is not "unset", it is a malformed word and fails the
    # boot, which is right for an operator and wrong for a harness. `exec`
    # so the pid recorded is node's, not an intermediate shell's: killing a
    # wrapper would orphan the relay, and bats then waits on it.
    (
        cd "$SERVER_DIR" && exec env \
            NODE_ENV=production PORT="$RELAY_PORT" HOST=127.0.0.1 \
            DATABASE_URL="$DATABASE_URL" HANDY_MASTER_SECRET="$(random_hex 32)" \
            PUBLIC_URL="$RELAY_URL" DATA_DIR="$STATE/data" METRICS_ENABLED=false \
            ACCOUNT_REGISTRATION=guest ACCOUNT_OWNER_PUBLIC_KEYS="$owner_hex" \
            ${escrow_seed:+RELAY_ESCROW_SECRET_KEY="$escrow_seed"} \
            ${RELAY_SHARING_UNDER_TEST:+RELAY_SHARING="$RELAY_SHARING_UNDER_TEST"} \
            node ../../node_modules/tsx/dist/cli.mjs sources/main.ts
    ) >"$STATE/relay.log" 2>&1 </dev/null 3>&- &
    echo $! >"$STATE/relay.pid"
    i=0
    until curl -fsS -m 2 "$RELAY_URL/health" >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -gt 60 ]; then
            echo "relay did not answer $RELAY_URL/health" >&2
            tail -40 "$STATE/relay.log" >&2
            exit 1
        fi
        sleep 1
    done
}

teardown_file() {
    STATE=${SHARED_SESSIONS_STATE_DIR:-${TMPDIR:-/tmp}/shared-sessions-test}
    [ -n "${SHARED_SESSIONS_KEEP:-}" ] && return 0
    if [ -f "$STATE/relay.pid" ]; then
        pid=$(cat "$STATE/relay.pid")
        kill "$pid" 2>/dev/null
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do
            i=$((i + 1))
            sleep 1
        done
        kill -9 "$pid" 2>/dev/null
    fi
    [ -f "$STATE/pg-name" ] && docker rm -f "$(cat "$STATE/pg-name")" >/dev/null 2>&1
    rm -rf "$STATE"
    return 0
}

setup() {
    FORK_DIR=${FORK_DIR:-$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)}
    STATE=${SHARED_SESSIONS_STATE_DIR:-${TMPDIR:-/tmp}/shared-sessions-test}
    RELAY_URL=$(cat "$STATE/url")
    FIXTURE=$(cat "$STATE/fixture")
    export FORK_DIR STATE RELAY_URL FIXTURE
}

# The CLI's own code, run from its own package so `@/` resolves, against a
# home and a state dir that exist only under the test's state dir.
client() (
    escrow_seed=""
    [ -f "$STATE/escrow-seed" ] && escrow_seed=$(cat "$STATE/escrow-seed")
    cd "$FORK_DIR/packages/happy-cli" &&
        FORK_DIR="$FORK_DIR" \
            HAPPY_HOME_DIR="$STATE/happy-home" \
            HAPPY_SERVER_URL="$RELAY_URL" \
            SHARED_SESSIONS_STATE="$STATE/state" \
            SHARED_SESSIONS_ESCROW_SEED="$escrow_seed" \
            node ../../node_modules/tsx/dist/cli.mjs "$BATS_TEST_DIRNAME/shared-sessions.mjs" "$@"
)

state() {
    jq -r "$2" "$STATE/state/$1.json"
}

pg() {
    docker exec "$(cat "$STATE/pg-name")" psql -U relay -d relay -At -c "$1"
}
