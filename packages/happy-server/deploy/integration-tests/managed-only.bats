#!/usr/bin/env bats
# deploy/integration-tests/managed-only.bats — a relay with an escrow key and
# RELAY_SHARING unset, measured (DROVE-388, decision 0c). This is the relay
# where "personal chats can't be shared ever": a private session is private,
# and sharing means managed.
#
# Same harness as shared-sessions.bats (shared-sessions-lib.sh), escrow seed
# minted, sharing left unset. Proves:
#   - GET /v1/relay announces the escrow key and sharing off;
#   - a private session cannot be shared at all (403 sharing-off on every
#     grant route), and a managed session next to it can, keyless;
#   - the Managed switch is what makes the difference: ON, the private session
#     shares; OFF, its keyless grants drop, the guest loses it, its grant
#     routes answer sharing-off again, and it carries wasManagedAt;
#   - the database holds escrow wraps for the managed session only and never
#     a plaintext key.
#
# Run (from the fork root, bats via asdf):
#   ASDF_BATS_VERSION=1.14.0 bats packages/happy-server/deploy/integration-tests/managed-only.bats

RELAY_ESCROW_UNDER_TEST=1
export RELAY_ESCROW_UNDER_TEST

. "$BATS_TEST_DIRNAME/shared-sessions-lib.sh"

@test "the relay can manage, and private sessions do not share" {
    run client relay
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .escrowMatchesSeed)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.sharing)" = "false" ]
    [ "$(printf '%s' "$output" | jq -r .body.signIn.secretKey)" = "true" ]
}

@test "the owner creates a private session and a managed session side by side" {
    run client auth owner
    [ "$(printf '%s' "$output" | jq -r .kind)" = "owner" ]
    run client auth guest
    [ "$(printf '%s' "$output" | jq -r .kind)" = "guest" ]
    run client register-key owner
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client register-key guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client create-session owner dataKey alpha
    [ "$status" -eq 0 ]
    run client create-session owner dataKey gamma managed
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-alpha .id)'")" = "t" ]
    [ "$(pg "select \"escrowKey\" is not null from \"Session\" where id = '$(state session-gamma .id)'")" = "t" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$(state session-alpha .id)\") | .managed")" = "false" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$(state session-gamma .id)\") | .managed")" = "true" ]
}

@test "the private session cannot be shared here, even with the owner's own re-wrap" {
    run client unwrap-and-rewrap alpha owner guest
    [ "$status" -eq 0 ]
    run client grant owner alpha guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "sharing-off" ]
    run client grants owner alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "sharing-off" ]
    run client revoke owner alpha guest
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "0" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    [ "$(pg 'select count(*) from "SessionGrant"')" = "0" ]
}

@test "the managed session shares, keyless, and the guest opens it with the relay's wrap" {
    run client grant-managed owner gamma guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client grants owner gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r '.body.grants | length')" = "1" ]
    sid=$(state session-gamma .id)
    [ "$(pg "select count(*) from \"SessionGrant\" where \"sessionId\" = '$sid' and \"wrappedKey\" is null")" = "1" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].id')" = "$sid" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].managed')" = "true" ]
    run client send gamma "$FIXTURE-managed" guest 5000
    [ "$(printf '%s' "$output" | jq -r .guestReceived)" = "true" ]
    run client read guest gamma
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    ciphertext=$(printf '%s' "$output" | jq -r '.messages[-1].c')
    run client decrypt guest gamma "$ciphertext" "$FIXTURE-managed"
    [ "$status" -eq 0 ]
}

@test "the Managed switch is the difference: ON shares the private session, OFF takes it back and remembers" {
    sid=$(state session-alpha .id)
    run client escrow-on owner alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.managed)" = "true" ]
    run client grant-managed owner alpha guest view
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "2" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client escrow-off owner alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.managed)" = "false" ]
    [ "$(printf '%s' "$output" | jq -r .body.droppedGrants)" = "1" ]
    was=$(printf '%s' "$output" | jq -r .body.wasManagedAt)
    [ "$was" != "null" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].id')" = "$(state session-gamma .id)" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    run client grants owner alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "403" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "sharing-off" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .managed")" = "false" ]
    [ "$(printf '%s' "$output" | jq -r ".sessions[] | select(.id == \"$sid\") | .wasManagedAt")" = "$was" ]
    [ "$(pg "select count(*) from \"SessionGrant\" where \"sessionId\" = '$sid'")" = "0" ]
}

@test "the database holds an escrow wrap for the managed session only and never a plaintext key" {
    alpha_hex=$(state session-alpha .encryptionKey | base64 -d | od -An -v -tx1 | tr -d ' \n')
    gamma_hex=$(state session-gamma .encryptionKey | base64 -d | od -An -v -tx1 | tr -d ' \n')
    [ "$(pg 'select count(*) from "Session" where "escrowKey" is not null')" = "1" ]
    [ "$(pg 'select count(*) from "SessionGrant" where "wrappedKey" is not null')" = "0" ]
    dump=$(docker exec "$(cat "$STATE/pg-name")" pg_dump -U relay -d relay --data-only)
    ! printf '%s' "$dump" | grep -qi "$alpha_hex"
    ! printf '%s' "$dump" | grep -qi "$gamma_hex"
    ! printf '%s' "$dump" | grep -q "$FIXTURE"
}
