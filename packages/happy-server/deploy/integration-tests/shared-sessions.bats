#!/usr/bin/env bats
# deploy/integration-tests/shared-sessions.bats — guest accounts and
# per-session grants, measured (DROVE-388).
#
# Brings a relay up FROM SOURCE (tsx sources/main.ts) on a free port against a
# throwaway Postgres container, with ACCOUNT_REGISTRATION=guest and the
# owner's fixture signing key pinned in ACCOUNT_OWNER_PUBLIC_KEYS. Then, with
# the fork's OWN CLI code (shared-sessions.mjs), proves:
#   - the pinned key becomes an owner and the other key a guest;
#   - a guest cannot create a session, list machines, approve a pairing, or
#     open a session- or machine-scoped socket;
#   - the owner's session is invisible to the guest until granted: empty list,
#     404 read, a silent socket;
#   - the owner unwraps the session key with its box secret key, re-wraps it
#     to the guest's box public key and grants read; the guest's list holds
#     exactly that session with the re-wrapped bytes as dataEncryptionKey,
#     the ciphertext it reads decrypts to the fixture with that key, and a
#     message sent after the grant reaches its socket;
#   - read cannot post (403); answer can, and the CLI's socket hears it;
#   - a legacy session (no data key) cannot be granted (409);
#   - the database holds the re-wrapped bytes and never the plaintext key;
#   - after revoke the guest sees nothing again.
#
# Needs: docker (daemon running), node, jq, and the fork's node_modules
# installed (tsx, prisma and socket.io-client come from there). Never touches
# ~/.happy: the CLI home is under the test's state dir and shared-sessions.mjs
# refuses any other. Every key is minted by the test and thrown away.
#
# Run (from the fork root, bats via asdf):
#   ASDF_BATS_VERSION=1.14.0 bats packages/happy-server/deploy/integration-tests/shared-sessions.bats
# SHARED_SESSIONS_KEEP=1 leaves the relay and the database up afterwards.

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

    # The owner's signing key must be pinned BEFORE the relay starts, so the
    # fixture keys are minted first. Nothing has talked to the relay yet.
    keygen=$(client keygen)
    owner_hex=$(printf '%s' "$keygen" | jq -r .ownerSignPublicKeyHex)
    [ -n "$owner_hex" ] || {
        echo "keygen did not report the owner's signing key: $keygen" >&2
        exit 1
    }

    # `exec` so the pid recorded is node's, not an intermediate shell's:
    # killing a wrapper would orphan the relay, and bats then waits on it.
    (
        cd "$SERVER_DIR" && exec env \
            NODE_ENV=production PORT="$RELAY_PORT" HOST=127.0.0.1 \
            DATABASE_URL="$DATABASE_URL" HANDY_MASTER_SECRET="$(random_hex 32)" \
            PUBLIC_URL="$RELAY_URL" DATA_DIR="$STATE/data" METRICS_ENABLED=false \
            ACCOUNT_REGISTRATION=guest ACCOUNT_OWNER_PUBLIC_KEYS="$owner_hex" \
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
    cd "$FORK_DIR/packages/happy-cli" &&
        FORK_DIR="$FORK_DIR" \
            HAPPY_HOME_DIR="$STATE/happy-home" \
            HAPPY_SERVER_URL="$RELAY_URL" \
            SHARED_SESSIONS_STATE="$STATE/state" \
            node ../../node_modules/tsx/dist/cli.mjs "$BATS_TEST_DIRNAME/shared-sessions.mjs" "$@"
)

state() {
    jq -r "$2" "$STATE/state/$1.json"
}

pg() {
    docker exec "$(cat "$STATE/pg-name")" psql -U relay -d relay -At -c "$1"
}

@test "docker, node and jq are available" {
    command -v docker
    docker info >/dev/null 2>&1
    command -v node
    command -v jq
}

@test "the relay answers /health" {
    run curl -fsS -m 5 "$RELAY_URL/health"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"status":"ok"'
}

@test "the pinned key becomes an owner and the other key a guest" {
    run client auth owner
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .kind)" = "owner" ]
    run client auth guest
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .kind)" = "guest" ]
    [ "$(state owner .accountId)" != "$(state guest .accountId)" ]
}

@test "each account registers its content key; a key another account holds is refused" {
    run client register-key owner
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client register-key guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    # The guest trying to claim the owner's key: 409, the owner keeps it.
    owner_key=$(state owner .boxPublicKey)
    run client http guest POST /v1/account/content-key "{\"contentPublicKey\":\"$owner_key\"}"
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "content-key-taken" ]
    run client http guest GET /v1/account/profile
    [ "$(printf '%s' "$output" | jq -r .body.contentPublicKey)" = "$(state guest .boxPublicKey)" ]
}

@test "a guest cannot create a session, list machines, or approve a pairing" {
    run client http guest POST /v1/sessions '{"tag":"guest-tries","metadata":"x"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "guest-account" ]
    run client http guest GET /v1/machines
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client http guest POST /v1/auth/response '{"response":"x","publicKey":"x"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client http guest POST /v1/auth/account/response '{"response":"x","publicKey":"x"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    # The owner still can: the gate is the kind, not the route.
    run client http owner GET /v1/machines
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
}

@test "a guest may connect user-scoped only" {
    run client socket-connect guest user-scoped
    [ "$(printf '%s' "$output" | jq -r .connected)" = "true" ]
    run client socket-connect guest session-scoped any-session
    [ "$(printf '%s' "$output" | jq -r .connected)" = "false" ]
    run client socket-connect guest machine-scoped
    [ "$(printf '%s' "$output" | jq -r .connected)" = "false" ]
    run client socket-connect owner machine-scoped
    [ "$(printf '%s' "$output" | jq -r .connected)" = "true" ]
}

@test "the owner creates a dataKey session through the CLI's ApiClient" {
    run client create-session owner dataKey alpha
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .variant)" = "dataKey" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "owner" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].ownerId')" = "$(state owner .accountId)" ]
}

@test "before any grant the guest sees nothing: empty list, 404 read, a silent socket" {
    run client send alpha "$FIXTURE-before" guest 2000
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "false" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "0" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client post guest alpha "$FIXTURE-guest-before" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
}

@test "the owner unwraps the session key with its box secret key and re-wraps it to the guest" {
    run client unwrap-and-rewrap alpha owner guest
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .unwrappedMatchesMinted)" = "true" ]
    printf '%s' "$output" | jq -r .dataKeyHex >"$STATE/alpha-datakey-hex"
    printf '%s' "$output" | jq -r .wrappedKeyHex >"$STATE/alpha-wrapped-hex"
    [ "$(wc -c <"$STATE/alpha-datakey-hex" | tr -d ' ')" -eq 65 ]
}

@test "a guest cannot grant, list grants, or grant to itself" {
    run client grant guest alpha owner read
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "guest-account" ]
    run client grants guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client grant owner alpha owner read
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "cannot-grant-to-self" ]
}

@test "a malformed wrapped key and an unknown grantee are refused" {
    sid=$(state session-alpha .id)
    run client http owner POST "/v1/sessions/$sid/grants" "{\"granteeContentPublicKey\":\"$(state guest .boxPublicKey)\",\"wrappedKey\":\"AAAA\",\"role\":\"read\"}"
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "wrapped-key-malformed" ]
    wrapped=$(state wrapped-alpha-guest .wrappedKey)
    stranger=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')
    run client http owner POST "/v1/sessions/$sid/grants" "{\"granteeContentPublicKey\":\"$stranger\",\"wrappedKey\":\"$wrapped\",\"role\":\"read\"}"
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "grantee-not-found" ]
}

@test "the owner grants read by the guest's content key" {
    run client grant owner alpha guest read
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "read" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.granteeAccountId)" = "$(state guest .accountId)" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.grantedById)" = "$(state owner .accountId)" ]
    run client grants owner alpha
    [ "$(printf '%s' "$output" | jq -r '.body.grants | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.body.grants[0].grantee.kind')" = "guest" ]
}

@test "the guest's list holds exactly that session, with the re-wrapped key in place of the owner's" {
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].id')" = "$(state session-alpha .id)" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "read" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].ownerId')" = "$(state owner .accountId)" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].dataEncryptionKey')" = "$(state wrapped-alpha-guest .wrappedKey)" ]
    # The owner's own row still carries the owner's wrap, not the guest's.
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].dataEncryptionKey')" != "$(state wrapped-alpha-guest .wrappedKey)" ]
}

@test "the guest reads the ciphertext and decrypts the fixture with the key it unwrapped" {
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r '.messages | length')" -ge 1 ]
    [ "$(printf '%s' "$output" | jq -r '.messages[0].t')" = "encrypted" ]
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[0].c')
    # Ciphertext on the wire is not the fixture.
    ! printf '%s' "$ciphertext" | grep -q "$FIXTURE"
    run client decrypt guest alpha "$ciphertext" "$FIXTURE-before"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .keyHex)" = "$(cat "$STATE/alpha-datakey-hex")" ]
}

@test "a message sent after the grant reaches the guest's socket" {
    run client send alpha "$FIXTURE-after" guest 5000
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "true" ]
}

@test "read cannot post; answer can, and the CLI's socket hears it" {
    run client post guest alpha "$FIXTURE-guest-read" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "read-only-grant" ]
    # Granting again replaces the role; no second row.
    run client grant owner alpha guest answer id
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "answer" ]
    run client grants owner alpha
    [ "$(printf '%s' "$output" | jq -r '.body.grants | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.body.grants[0].role')" = "answer" ]
    run client post guest alpha "$FIXTURE-guest-answer" 5000
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .cliReceived)" = "true" ]
    # And the owner reads the guest's message back under the session key.
    run client read owner alpha
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[-1].c')
    run client decrypt owner alpha "$ciphertext" "$FIXTURE-guest-answer"
    [ "$status" -eq 0 ]
}

@test "the database holds the re-wrapped bytes and never the plaintext session key" {
    run pg "select encode(\"wrappedKey\", 'hex') from \"SessionGrant\""
    [ "$status" -eq 0 ]
    [ "$output" = "$(cat "$STATE/alpha-wrapped-hex")" ]
    dump=$(docker exec "$(cat "$STATE/pg-name")" pg_dump -U relay -d relay --data-only)
    ! printf '%s' "$dump" | grep -qi "$(cat "$STATE/alpha-datakey-hex")"
    ! printf '%s' "$dump" | grep -q "$FIXTURE"
}

@test "a legacy session with no data key cannot be granted" {
    run client create-session owner legacy old
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .variant)" = "legacy" ]
    run client grant owner old guest read
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "session-not-shareable" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
}

@test "after revoke the guest sees nothing again" {
    run client revoke owner alpha guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "0" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client post guest alpha "$FIXTURE-guest-revoked" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client send alpha "$FIXTURE-revoked" guest 2000
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "false" ]
    run client revoke owner alpha guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run pg 'select count(*) from "SessionGrant"'
    [ "$output" = "0" ]
    # The owner lost nothing.
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "2" ]
}
