#!/usr/bin/env bats
# deploy/integration-tests/private-default.bats — a relay with NOTHING set,
# measured (DROVE-388, decision 0c): no escrow key, so it cannot manage a
# session; RELAY_SHARING unset, so a private session cannot be shared. It
# is exactly the relay from before grants existed.
#
# Same harness as shared-sessions.bats (shared-sessions-lib.sh), with neither
# knob set, which is how a relay nobody configured comes up. Proves:
#   - GET /v1/relay announces no escrow key, sharing off, the secret key as
#     the one way in;
#   - the owner creates a session through the CLI and cannot grant it (403
#     sharing-off), list its grants, or revoke one;
#   - a guest sees nothing, before and after the refused grant;
#   - managed is not available: --managed fails the create with one line,
#     the account default quietly makes a private session, and the switch
#     answers 409 relay-cannot-manage.
#
# Run (from the fork root, bats via asdf):
#   ASDF_BATS_VERSION=1.14.0 bats packages/happy-server/deploy/integration-tests/private-default.bats

. "$BATS_TEST_DIRNAME/shared-sessions-lib.sh"

@test "an unconfigured relay cannot manage, does not share, and offers the secret key as the way in" {
    run client relay
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    [ "$(printf '%s' "$output" | jq -r .body.escrowPublicKey)" = "null" ]
    [ "$(printf '%s' "$output" | jq -r .body.sharing)" = "false" ]
    [ "$(printf '%s' "$output" | jq -r .body.registration)" = "guest" ]
    [ "$(printf '%s' "$output" | jq -r .body.signIn.secretKey)" = "true" ]
    [ "$(printf '%s' "$output" | jq -r .body.signIn.oidc)" = "null" ]
    [ "$(printf '%s' "$output" | jq -r '.body | has("mode")')" = "false" ]
}

@test "the owner works as before: signs in, registers a key, creates a private session through the CLI" {
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
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-alpha .id)'")" = "t" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].role')" = "owner" ]
    [ "$(printf '%s' "$output" | jq -r '.sessions[0].managed')" = "false" ]
}

@test "every grant route answers sharing-off, and the guest sees nothing" {
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
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "sharing-off" ]
    run client list guest
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "0" ]
    run client read guest alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "404" ]
    [ "$(pg 'select count(*) from "SessionGrant"')" = "0" ]
}

@test "managed is not available here: --managed fails with one line, the default stays private, the switch says why" {
    run client create-session owner dataKey beta managed
    [ "$status" -ne 0 ]
    printf '%s' "$output" | grep -q "cannot manage sessions"
    [ ! -f "$STATE/state/session-beta.json" ]
    # The account default asks for managed; the relay cannot, so the session
    # is private and the CLI does not fail: the default is a preference.
    run client set-managed-default owner on
    [ "$(printf '%s' "$output" | jq -r .status)" = "200" ]
    run client create-session owner dataKey beta
    [ "$status" -eq 0 ]
    [ "$(pg "select \"escrowKey\" is null from \"Session\" where id = '$(state session-beta .id)'")" = "t" ]
    run client escrow-on owner alpha
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "relay-cannot-manage" ]
    run client http owner POST /v1/sessions '{"tag":"asks-managed","metadata":"x","dataEncryptionKey":"AAAA","escrowKey":"AAAA"}'
    [ "$(printf '%s' "$output" | jq -r .status)" = "409" ]
    [ "$(printf '%s' "$output" | jq -r .body.error)" = "relay-cannot-manage" ]
    run client list owner
    [ "$(printf '%s' "$output" | jq -r '.sessions | length')" = "2" ]
    [ "$(pg 'select count(*) from "Session" where "escrowKey" is not null')" = "0" ]
}
