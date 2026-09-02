#!/usr/bin/env bats
# deploy/integration-tests/shared-sessions.bats — PRIVATE and MANAGED sessions
# side by side on ONE relay, measured in one run (DROVE-388, decision 0c).
#
# Brings a relay up FROM SOURCE (tsx sources/main.ts) on a free port against a
# throwaway Postgres container, with ACCOUNT_REGISTRATION=guest, the owner's
# fixture signing key pinned, an escrow seed the test mints (so the relay CAN
# manage) and RELAY_SHARING=on (so private sessions may be shared end to end
# as well). Then, with the fork's OWN CLI code (shared-sessions.mjs), proves:
#   - the pinned key becomes an owner and the other key a guest; a guest
#     cannot create a session, list machines, approve a pairing, or open a
#     session- or machine-scoped socket;
#   - a session the CLI creates with no flag is PRIVATE: no escrow wrap, the
#     relay is blind, and a grant on it needs the owner's own re-wrap; the
#     guest's list holds exactly that session with the re-wrapped bytes as
#     dataEncryptionKey, decrypts the fixture with them, hears a message sent
#     after the grant; view cannot post, send can;
#   - a session the CLI creates with --managed is MANAGED: the session key is
#     wrapped to the relay's escrow key at create and opens with the seed; a
#     grant on it carries no key and the relay wraps for the guest on read;
#   - the defaults: the account's "new sessions managed" setting, this
#     machine's override, and the flag, in that order of strength;
#   - the Managed switch: ON puts an escrow wrap on a private session, OFF
#     deletes it, drops the keyless grants and sets wasManagedAt, which the
#     session then carries for good; a legacy session cannot be switched;
#   - a legacy session (no data key) cannot be granted (409) either way;
#   - the pinned owner is an admin and flips a guest's kind;
#   - revoke removes the guest's access to both kinds; the database holds
#     re-wrapped bytes, escrow wraps and keyless grants, never a plaintext key.
#
# Needs: docker (daemon running), node, jq, and the fork's node_modules
# installed (tsx, prisma and socket.io-client come from there). Never touches
# ~/.happy: the CLI home is under the test's state dir and shared-sessions.mjs
# refuses any other. Every key is minted by the test and thrown away.
#
# Run (from the fork root, bats via asdf):
#   ASDF_BATS_VERSION=1.14.0 bats packages/happy-server/deploy/integration-tests/shared-sessions.bats
# SHARED_SESSIONS_KEEP=1 leaves the relay and the database up afterwards.
# The harness (relay, database, the `client` and `pg` helpers) lives in
# shared-sessions-lib.sh. managed-only.bats measures the same relay with
# RELAY_SHARING unset; private-default.bats a relay with nothing set.

RELAY_ESCROW_UNDER_TEST=1
RELAY_SHARING_UNDER_TEST=on
export RELAY_ESCROW_UNDER_TEST RELAY_SHARING_UNDER_TEST

. "$BATS_TEST_DIRNAME/shared-sessions-lib.sh"

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

@test "the relay can manage, private sharing is on, and it offers the secret key as a way in" {
    run client relay
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .escrowMatchesSeed)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.sharing)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.registration)" = "guest" ]
    [ "$(printf '%s' "$output" | jq -r .body.signIn.secretKey)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.signIn.oidc)" = "null" ]
    # No mode word anywhere on the wire.
    [ "$(printf '%s' "$output" | jq -r '.body | has("mode")')" = "false" ]
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
    [ "$(printf '%s' "$output" | jq -r .body.newSessionsManaged)" = "false" ]
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

@test "with no flag the CLI's ApiClient creates a PRIVATE session: no escrow wrap, the relay blind" {
    run client create-session owner dataKey alpha
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .variant)" = "dataKey" ]
    sid=$(state session-alpha .id)
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$sid'")" = "t" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "owner" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].ownerId')" = "$(state owner .accountId)" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].managed')" = "false" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].wasManagedAt')" = "null" ]
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
    run client grant guest alpha owner view
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "guest-account" ]
    run client grants guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client grant owner alpha owner view
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "cannot-grant-to-self" ]
}

@test "a malformed wrapped key and an unknown grantee are refused" {
    sid=$(state session-alpha .id)
    run client http owner POST "/v1/sessions/$sid/grants" "{\"granteeContentPublicKey\":\"$(state guest .boxPublicKey)\",\"wrappedKey\":\"AAAA\",\"role\":\"view\"}"
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "wrapped-key-malformed" ]
    wrapped=$(state wrapped-alpha-guest .wrappedKey)
    stranger=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')
    run client http owner POST "/v1/sessions/$sid/grants" "{\"granteeContentPublicKey\":\"$stranger\",\"wrappedKey\":\"$wrapped\",\"role\":\"view\"}"
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "grantee-not-found" ]
}

@test "a private session needs the owner's re-wrap on every grant: the relay has no key to make one" {
    run client grant-managed owner alpha guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "wrapped-key-required" ]
    [ "$(pg 'select count(*) from "SessionGrant"')" = "0" ]
}

@test "the owner grants view on the private session by the guest's content key" {
    run client grant owner alpha guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "view" ]
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
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "view" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].ownerId')" = "$(state owner .accountId)" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].managed')" = "false" ]
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

@test "on the private session view cannot post; send can, and the CLI's socket hears it" {
    run client post guest alpha "$FIXTURE-guest-view" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "view-only-grant" ]
    # Granting again replaces the role; no second row.
    run client grant owner alpha guest send id
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "send" ]
    run client grants owner alpha
    [ "$(printf '%s' "$output" | jq -r '.body.grants | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.body.grants[0].role')" = "send" ]
    run client post guest alpha "$FIXTURE-guest-send" 5000
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .cliReceived)" = "true" ]
    # And the owner reads the guest's message back under the session key.
    run client read owner alpha
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[-1].c')
    run client decrypt owner alpha "$ciphertext" "$FIXTURE-guest-send"
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
    run client grant owner old guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "session-not-shareable" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
}

@test "with --managed the CLI creates a MANAGED session: the key is escrowed to the relay and opens with the seed" {
    run client create-session owner dataKey gamma managed
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .variant)" = "dataKey" ]
    sid=$(state session-gamma .id)
    escrow=$(pg "select encode(\"escrowKey\", 'base64') from \"Session\" where id = '$sid'")
    [ -n "$escrow" ]
    run client escrow-open "$escrow" gamma
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .matchesMinted)" = "true" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .managed")" = "true" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .wasManagedAt")" = "null" ]
    # The owner's own wrap is still the owner's: escrow is in addition.
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .dataEncryptionKey")" != "null" ]
    # The private session next to it is untouched.
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$(state session-alpha .id)\") | .managed")" = "false" ]
}

@test "a grant on the managed session carries no key; the relay wraps for the guest on read" {
    run client grant-managed owner gamma guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "view" ]
    sid=$(state session-gamma .id)
    [ "$(pg "select count(*) from \"SessionGrant\" where \"sessionId\" = '$sid' and \"wrappedKey\" is null")" = "1" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "2" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .role")" = "view" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .managed")" = "true" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .dataEncryptionKey")" != "null" ]
    # A message sent after the grant reaches the guest, and the guest opens
    # it with the key the relay wrapped for it.
    run client send gamma "$FIXTURE-managed" guest 5000
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "true" ]
    run client read guest gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[-1].c')
    run client decrypt guest gamma "$ciphertext" "$FIXTURE-managed"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .who)" = "guest" ]
}

@test "on the managed session view cannot post; send can, and the CLI's socket hears it" {
    run client post guest gamma "$FIXTURE-guest-view-managed" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "view-only-grant" ]
    run client grant-managed owner gamma guest send
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.grant.role)" = "send" ]
    run client post guest gamma "$FIXTURE-guest-send-managed" 5000
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .cliReceived)" = "true" ]
}

@test "the defaults: the account's setting, then this machine's override, then the flag, each beating the last" {
    # The account's "new sessions managed" setting is the owner's to set.
    run client set-managed-default guest on
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client set-managed-default owner on
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client http owner GET /v1/account/profile
    [ "$(printf '%s' "$output" | jq -r .body.newSessionsManaged)" = "true" ]
    # No flag, no machine override: the account says managed.
    run client create-session owner dataKey delta
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is not null from \"Session\" where id = '$(state session-delta .id)'")" = "t" ]
    # This machine says private, and the machine beats the account.
    run client machine-default off
    [ "$status" -eq 0 ]
    run client create-session owner dataKey epsilon
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-epsilon .id)'")" = "t" ]
    # The flag beats the machine.
    run client create-session owner dataKey zeta managed
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is not null from \"Session\" where id = '$(state session-zeta .id)'")" = "t" ]
    run client create-session owner dataKey theta private
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-theta .id)'")" = "t" ]
    # Back to nothing set: private.
    run client machine-default unset
    run client set-managed-default owner off
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client create-session owner dataKey eta
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-eta .id)'")" = "t" ]
}

@test "the Managed switch, ON: a private session gets an escrow wrap from its owner and becomes shareable without a re-wrap" {
    run client create-session-raw owner beta
    [ "$status" -eq 0 ]
    run client grant-managed owner beta guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "wrapped-key-required" ]
    run client escrow-on owner beta
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.managed)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.wasManagedAt)" = "null" ]
    sid=$(state session-beta .id)
    escrow=$(pg "select encode(\"escrowKey\", 'base64') from \"Session\" where id = '$sid'")
    run client escrow-open "$escrow" beta
    [ "$(printf '%s' "$output" | jq -r .matchesMinted)" = "true" ]
    run client grant-managed owner beta guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client send beta "$FIXTURE-beta" guest 5000
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "true" ]
    run client read guest beta
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[-1].c')
    run client decrypt guest beta "$ciphertext" "$FIXTURE-beta"
    [ "$status" -eq 0 ]
}

@test "a malformed escrow wrap is refused at create and at the switch; a guest cannot switch anything" {
    run client http owner POST /v1/sessions '{"tag":"bad-escrow","metadata":"x","dataEncryptionKey":"AAAA","escrowKey":"AAAA"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "escrow-key-malformed" ]
    run client http owner PUT "/v1/sessions/$(state session-beta .id)/escrow" '{"escrowKey":"AAAA"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "escrow-key-malformed" ]
    run client http guest PUT "/v1/sessions/$(state session-beta .id)/escrow" '{"escrowKey":"AAAA"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client http guest DELETE "/v1/sessions/$(state session-beta .id)/escrow"
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    # Beta is still managed after all that.
    [ "$(pg "select \"escrowKey\" is not null from \"Session\" where id = '$(state session-beta .id)'")" = "t" ]
}

@test "the Managed switch, OFF: the relay forgets the wrap, drops the keyless grants, and the session remembers it was managed" {
    sid=$(state session-gamma .id)
    run client escrow-off owner gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.managed)" = "false" ]
    [ "$(printf '%s' "$output" | jq -r .body.droppedGrants)" = "1" ]
    was=$(printf '%s' "$output" | jq -r .body.wasManagedAt)
    [ "$was" != "null" ]
    [ "$(pg "select \"escrowKey\" is null and \"wasManagedAt\" is not null from \"Session\" where id = '$sid'")" = "t" ]
    [ "$(pg "select count(*) from \"SessionGrant\" where \"sessionId\" = '$sid'")" = "0" ]
    # The guest lost gamma and nothing else.
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "2" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .id")" = "" ]
    run client read guest gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    # The owner's row says so, in the clear.
    run client list owner
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .managed")" = "false" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .wasManagedAt")" = "$was" ]
    # Off again is a no-op that keeps the date.
    run client escrow-off owner gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.droppedGrants)" = "0" ]
    [ "$(printf '%s' "$output" | jq -r .body.wasManagedAt)" = "$was" ]
    # On again: managed, and the date stays for good.
    run client escrow-on owner gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.managed)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.wasManagedAt)" = "$was" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .managed")" = "true" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .wasManagedAt")" = "$was" ]
}

@test "a legacy session cannot be switched to managed: there is no session key to escrow" {
    run client http owner PUT "/v1/sessions/$(state session-old .id)/escrow" '{"escrowKey":"AAAA"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "session-not-shareable" ]
    run client grant-managed owner old guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "session-not-shareable" ]
}

@test "the pinned owner is an admin; a guest is not; the switch flips kind and never the admin's own" {
    run client accounts guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "admin-only" ]
    run client set-kind guest owner guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client set-kind owner owner guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "400" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "cannot-change-own-kind" ]
    run client accounts owner
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r '.body.accounts | length')" = "2" ]
    [ "$(printf '%s' "$output" | jq -r ".body.accounts[] | select(.id == \"$(state owner .accountId)\") | .admin")" = "true" ]
    [ "$(printf '%s' "$output" | jq -r ".body.accounts[] | select(.id == \"$(state guest .accountId)\") | .admin")" = "false" ]
    # Flip the guest to owner: it may now create a session. Then back.
    run client set-kind owner guest owner
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client http guest POST /v1/sessions '{"tag":"guest-now-owner","metadata":"x"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client socket-connect guest machine-scoped
    [ "$(printf '%s' "$output" | jq -r .connected)" = "true" ]
    run client set-kind owner guest guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client http guest POST /v1/sessions '{"tag":"guest-again","metadata":"x"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client socket-connect guest machine-scoped
    [ "$(printf '%s' "$output" | jq -r .connected)" = "false" ]
}

@test "after revoke on both kinds the guest sees only the session it owns itself" {
    run client revoke owner alpha guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client revoke owner beta guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    # What is left is the session the guest made while it was an owner.
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "owner" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].ownerId')" = "$(state guest .accountId)" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client read guest beta
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client post guest alpha "$FIXTURE-guest-revoked" 2000
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client send alpha "$FIXTURE-revoked" guest 2000
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "false" ]
    run client send beta "$FIXTURE-revoked-managed" guest 2000
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "false" ]
    run client revoke owner alpha guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run pg 'select count(*) from "SessionGrant"'
    [ "$output" = "0" ]
    # The owner lost nothing: alpha, old, gamma, delta, epsilon, zeta, theta, eta, beta.
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "9" ]
}

@test "the database holds escrow wraps for the managed sessions and never a plaintext session key" {
    alpha_hex=$(cat "$STATE/alpha-datakey-hex")
    gamma_hex=$(state session-gamma .encryptionKey | base64 -d | od -An -v -tx1 | tr -d ' \n')
    [ "${#gamma_hex}" = "64" ]
    # gamma (on again), delta, zeta, beta.
    [ "$(pg "select count(*) from \"Session\" where \"escrowKey\" is not null")" = "4" ]
    [ "$(pg "select count(*) from \"Session\" where \"wasManagedAt\" is not null")" = "1" ]
    [ "$(pg "select count(*) from \"Session\" where encode(\"escrowKey\", 'hex') like '%$gamma_hex%' or encode(\"dataEncryptionKey\", 'hex') like '%$gamma_hex%' or encode(\"escrowKey\", 'hex') like '%$alpha_hex%' or encode(\"dataEncryptionKey\", 'hex') like '%$alpha_hex%'")" = "0" ]
    dump=$(docker exec "$(cat "$STATE/pg-name")" pg_dump -U relay -d relay --data-only)
    ! printf '%s' "$dump" | grep -qi "$gamma_hex"
    ! printf '%s' "$dump" | grep -qi "$alpha_hex"
    ! printf '%s' "$dump" | grep -q "$FIXTURE"
}
