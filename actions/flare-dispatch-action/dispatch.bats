#!/usr/bin/env bats
#
# Unit tests for the pure helpers in dispatch.sh. These are reachable ONLY
# because dispatch.sh guards `main` behind `[ "${BASH_SOURCE[0]}" = "${0}" ]`,
# so sourcing the script defines the functions without dispatching anything.
#
# Run: bats actions/flare-dispatch-action/dispatch.bats
# Each case runs the helper in a fresh `bash -c` so the script's own
# `set -euo pipefail` applies exactly as it does in production.

setup() {
  export SCRIPT="${BATS_TEST_DIRNAME}/dispatch.sh"
}

# --- to_uint -----------------------------------------------------------------

@test "to_uint passes through a positive integer" {
  run env bash -c 'source "$SCRIPT"; to_uint 42'
  [ "$status" -eq 0 ]
  [ "$output" = "42" ]
}

@test "to_uint maps empty to 0" {
  run env V='' bash -c 'source "$SCRIPT"; to_uint "$V"'
  [ "$output" = "0" ]
}

@test "to_uint maps non-numeric to 0" {
  run env V='12abc' bash -c 'source "$SCRIPT"; to_uint "$V"'
  [ "$output" = "0" ]
}

# --- resolve_head_sha --------------------------------------------------------

@test "resolve_head_sha returns GITHUB_SHA on push events" {
  run env GITHUB_EVENT_NAME=push GITHUB_SHA=aaaaaaaaaaaa bash -c 'source "$SCRIPT"; resolve_head_sha'
  [ "$status" -eq 0 ]
  [ "$output" = "aaaaaaaaaaaa" ]
}

@test "resolve_head_sha prefers the PR head sha over the merge sha" {
  echo '{"pull_request":{"head":{"sha":"headsha123"}}}' > "$BATS_TEST_TMPDIR/ev.json"
  run env GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$BATS_TEST_TMPDIR/ev.json" GITHUB_SHA=mergesha000 \
    bash -c 'source "$SCRIPT"; resolve_head_sha'
  [ "$output" = "headsha123" ]
}

@test "resolve_head_sha falls back to GITHUB_SHA when the event file is unreadable" {
  run env GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=/nonexistent/ev.json GITHUB_SHA=fallbacksha \
    bash -c 'source "$SCRIPT"; resolve_head_sha'
  [ "$output" = "fallbacksha" ]
}

# --- normalize_notify --------------------------------------------------------

@test "normalize_notify: empty -> []" {
  run env V='' bash -c 'source "$SCRIPT"; normalize_notify "$V"'
  [ "$output" = "[]" ]
}

@test "normalize_notify: comma/space string -> JSON array" {
  run env V='alice@x.com, bob@y.com' bash -c 'source "$SCRIPT"; normalize_notify "$V"'
  [ "$output" = '["alice@x.com","bob@y.com"]' ]
}

@test "normalize_notify: JSON array passthrough drops blanks" {
  run env V='["a@x.com","","b@y.com"]' bash -c 'source "$SCRIPT"; normalize_notify "$V"'
  [ "$output" = '["a@x.com","b@y.com"]' ]
}

# --- signals_invalid_reason --------------------------------------------------

@test "signals_invalid_reason: valid signal -> empty" {
  run env J='[{"source":"ci","title":"t","detail":"d"}]' \
    bash -c 'source "$SCRIPT"; set +o pipefail; printf "%s" "$J" | signals_invalid_reason'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "signals_invalid_reason: missing source is reported" {
  run env J='[{"title":"t","detail":"d"}]' \
    bash -c 'source "$SCRIPT"; set +o pipefail; printf "%s" "$J" | signals_invalid_reason'
  [[ "$output" == *'needs a string "source"'* ]]
}

@test "signals_invalid_reason: non-object entry is reported" {
  run env J='[1]' \
    bash -c 'source "$SCRIPT"; set +o pipefail; printf "%s" "$J" | signals_invalid_reason'
  [[ "$output" == *'is not an object'* ]]
}

@test "signals_invalid_reason: over-50 cap is reported" {
  run env J="$(python3 -c 'import json;print(json.dumps([{"source":"s","title":"t","detail":"d"}]*51))')" \
    bash -c 'source "$SCRIPT"; set +o pipefail; printf "%s" "$J" | signals_invalid_reason'
  [[ "$output" == *'too many signals (51 > 50)'* ]]
}

@test "signals_invalid_reason: per-field length cap is reported" {
  run env J="$(python3 -c 'import json;print(json.dumps([{"source":"x"*121,"title":"t","detail":"d"}]))')" \
    bash -c 'source "$SCRIPT"; set +o pipefail; printf "%s" "$J" | signals_invalid_reason'
  [[ "$output" == *'source exceeds 120 chars'* ]]
}

# --- compute_targets: idempotency key ----------------------------------------

@test "compute_targets keys an unlabelled dispatch as run-repo-sha12" {
  run env GITHUB_REPOSITORY=owner/name INPUT_RUN=worker-deploy ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{\"repo\":\"owner/name\"}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$status" -eq 0 ]
  [ "$output" = "worker-deploy-owner_name-0123456789ab" ]
}

@test "compute_targets folds checkLabel into the key so labelled dispatches stay distinct" {
  run env GITHUB_REPOSITORY=owner/name INPUT_RUN=worker-deploy ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{\"checkLabel\":\"containers\"}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$status" -eq 0 ]
  [ "$output" = "worker-deploy-containers-owner_name-0123456789ab" ]
}

@test "compute_targets keeps the bare key on the first run attempt" {
  run env GITHUB_REPOSITORY=owner/name GITHUB_RUN_ATTEMPT=1 INPUT_RUN=worker-deploy ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{\"checkLabel\":\"preview\"}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$status" -eq 0 ]
  [ "$output" = "worker-deploy-preview-owner_name-0123456789ab" ]
}

@test "compute_targets gives a GitHub job re-run its own execution" {
  run env GITHUB_REPOSITORY=owner/name GITHUB_RUN_ATTEMPT=2 INPUT_RUN=worker-deploy ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{\"checkLabel\":\"preview\"}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$status" -eq 0 ]
  [ "$output" = "worker-deploy-preview-owner_name-0123456789ab-attempt-2" ]
}

@test "compute_targets ignores a non-numeric run attempt" {
  run env GITHUB_REPOSITORY=owner/name GITHUB_RUN_ATTEMPT=x INPUT_RUN=check ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$output" = "check-owner_name-0123456789ab" ]
}

@test "compute_targets ignores a non-string checkLabel" {
  run env GITHUB_REPOSITORY=owner/name INPUT_RUN=check ENDPOINT=https://d.example \
    bash -c 'source "$SCRIPT"; SHA=0123456789abcdef; INPUTS="{\"checkLabel\":7}"; compute_targets; echo "$IDEMPOTENCY_KEY"'
  [ "$output" = "check-owner_name-0123456789ab" ]
}
