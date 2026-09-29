#!/usr/bin/env bash
#
# flare-dispatch-action — sign a dispatch body and POST it to a FlareDispatch
# Dispatcher. Consumed by action.yml (a composite action); every knob arrives
# as an `INPUT_*` env var, exactly as GitHub Actions exposes `with:` inputs.
#
# The contract this implements is specs/04-gha-integration.md § Action mode and
# apps/dispatcher/src/routes/dispatch.ts:
#
#   POST ${endpoint}/v1/dispatch/${run}
#     X-FlareDispatch-Signature: sha256=<hex over the RAW body bytes>
#     Idempotency-Key: <run>[-<checkLabel>]-<repo>-<sha12>[-attempt-<N>]
#   202 { executionId, detailsUrl?, logsUrl? }   → outputs, success
#   401                                           → HMAC drift, no retry
#   400 / 404                                     → config bug, no retry
#   000 / 429 / 5xx                               → transient, retry ≤3×
#
# The run executes ASYNCHRONOUSLY on Cloudflare; its verdict lands on the PR as
# a `flare-dispatch/<run>` check-run, NOT via this step. This step succeeds the
# moment the dispatch is accepted (202) — gate branch protection on the
# check-run name, not this job.
#
# Raw-bytes HMAC contract: the compact JSON is written to a file ONCE, and that
# exact file is both signed and sent (`--data-binary`), so signer and verifier
# see identical octets without agreeing on a canonical JSON form (hmac.ts).
#
# Structure: pure, side-effect-free helpers (resolve_head_sha, normalize_notify,
# signals_invalid_reason, to_uint, sign_body) are unit-tested by dispatch.bats;
# the pipeline steps (validate → collect → assemble → sign → POST → outputs) run
# from main(), which is invoked only when the script is executed, not sourced.
#
# Deps: bash, jq, openssl, curl — all preinstalled on GitHub-hosted runners.

set -euo pipefail

# --- log helpers -------------------------------------------------------------

# GitHub error annotation. Values are stripped of CR/LF so a hostile field can
# never inject a second `::workflow-command::` into the runner log.
err() { printf '::error::%s\n' "$(printf '%s' "$*" | tr -d '\r\n')" >&2; }
note() { printf '%s\n' "$(printf '%s' "$*" | tr -d '\r\n')"; }

# --- temp-file lifecycle -----------------------------------------------------
# One registry + an EXIT trap, so every scratch file is cleaned up on any exit
# path. `mktmp VAR` stores the path in VAR via `printf -v` (NOT command
# substitution) so the registration lands in THIS shell — a `VAR="$(mktmp)"`
# would append inside a subshell and the trap could never see the file.

declare -a TMPFILES=()
mktmp() { local f; f="$(mktemp)"; TMPFILES+=("$f"); printf -v "$1" '%s' "$f"; }
cleanup() { if [ "${#TMPFILES[@]}" -gt 0 ]; then rm -f "${TMPFILES[@]}"; fi; }

# --- small helpers -----------------------------------------------------------

# Coerce to an unsigned integer, defaulting to 0 for empty / non-numeric input.
to_uint() { case "$1" in '' | *[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }

# Read a string field off the 202 response (global $resp), CR/LF-stripped so a
# hostile value can't inject a workflow command through the step output.
resp_field() {
  local v
  v="$(jq -r --arg k "$1" '.[$k] // ""' <<<"$resp" 2>/dev/null)" || v=""
  printf '%s' "$v" | tr -d '\r\n'
}

require_deps() {
  local bin
  for bin in "$@"; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      err "'$bin' is required but not on PATH."
      exit 1
    fi
  done
}

require() { # name value
  if [ -z "${2:-}" ]; then
    err "'${1}' input is required"
    exit 1
  fi
}

# --- mode gate ---------------------------------------------------------------
# V0 ships fire-and-forget only; reject anything else BEFORE touching the
# network so a typo'd `await` fails loud instead of dispatching silently.

assert_mode() {
  local mode="${INPUT_MODE:-fire-and-forget}"
  if [ "$mode" != "fire-and-forget" ]; then
    err "mode='${mode}' — only 'fire-and-forget' is supported (await mode is deferred). Set mode: fire-and-forget."
    exit 1
  fi
}

# --- required inputs + endpoint ----------------------------------------------
# Strip a single trailing slash and reject any non-http(s) scheme before it can
# reach curl (keeps file://, data:, and metadata-only URLs out). Sets $ENDPOINT.

validate_inputs() {
  require run "${INPUT_RUN:-}"
  require endpoint "${INPUT_ENDPOINT:-}"
  require hmac-secret "${INPUT_HMAC_SECRET:-}"

  ENDPOINT="${INPUT_ENDPOINT%/}"
  case "$ENDPOINT" in
    https://* | http://*) : ;;
    *)
      err "'endpoint' must start with http:// or https:// — got: ${ENDPOINT}"
      exit 1
      ;;
  esac
}

# --- resolve the head SHA ----------------------------------------------------
# On pull_request events GITHUB_SHA is the ephemeral test-merge commit; a
# check-run posted there is invisible on the PR head and branch protection
# can't gate it. The verdict belongs on the PR head SHA — read it off the event
# payload, falling back to GITHUB_SHA for push events / when unreadable.

resolve_head_sha() {
  local fallback="${GITHUB_SHA:-}"
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request | pull_request_target) : ;;
    *)
      printf '%s' "$fallback"
      return
      ;;
  esac
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
    local head
    head="$(jq -r '.pull_request.head.sha // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || true)"
    if [ -n "$head" ]; then
      printf '%s' "$head"
      return
    fi
  fi
  printf '%s' "$fallback"
}

# --- inputs (JSON) -----------------------------------------------------------
# Validate INPUT_INPUTS as JSON and stash the compact form in $INPUTS.

load_inputs_json() {
  local raw="${INPUT_INPUTS:-}"
  [ -z "$raw" ] && raw='{}'
  if ! jq -e . >/dev/null 2>&1 <<<"$raw"; then
    err "'inputs' is not valid JSON: ${raw}"
    exit 1
  fi
  INPUTS="$(jq -c . <<<"$raw")"
}

# Print a human reason if the signals array on stdin violates signals/v1 shape;
# print nothing if valid. Pure — the caller decides whether to fail. Caps mirror
# schemas/signals.v1.schema.json.
signals_invalid_reason() {
  jq -r '
    def cap(f; n): if (has(f) and (.[f] | type) == "string" and (.[f] | length) > n)
                   then "\(f) exceeds \(n) chars" else empty end;
    if (length > 50) then "too many signals (\(length) > 50)"
    else ( to_entries[] | .key as $i | .value |
      if (type != "object") then "signal[\($i)] is not an object"
      elif ((has("source") and (.source | type) == "string") | not) then "signal[\($i)] needs a string \"source\""
      elif ((has("title")  and (.title  | type) == "string") | not) then "signal[\($i)] needs a string \"title\""
      elif ((has("detail") and (.detail | type) == "string") | not) then "signal[\($i)] needs a string \"detail\""
      else (cap("source"; 120), cap("title"; 200), cap("detail"; 2000), cap("url"; 1000))
      end )
    end' | head -n1
}

# --- collect-command: fold consumer-side observability signals into inputs ---
# Optional. The command runs in the workspace and must print ONLY signals/v1
# JSON to stdout (a bare array, or { "signals": [...] }) and exit 0. A broken
# collector fails the Action HERE, before anything is signed or sent. Mutates
# the global $INPUTS.

fold_in_signals() {
  [ -n "${INPUT_COLLECT_COMMAND:-}" ] || return 0

  if [ "$(jq -r 'type' <<<"$INPUTS")" != "object" ]; then
    err "collect-command requires 'inputs' to be a JSON object (signals are merged into it) — got a non-object."
    exit 1
  fi

  local collect_err collect_out collect_rc collected reason merged_count now_ms
  mktmp collect_err
  mktmp collect_out
  set +e
  (cd "${GITHUB_WORKSPACE:-$PWD}" && bash -c "$INPUT_COLLECT_COMMAND") \
    >"$collect_out" 2>"$collect_err"
  collect_rc=$?
  set -e
  if [ "$collect_rc" -ne 0 ]; then
    err "collect-command exited ${collect_rc} — a signals collector must exit 0 with valid signals/v1 JSON. stderr tail: $(tail -c 1000 "$collect_err" 2>/dev/null || true)"
    exit 1
  fi

  # Normalize a bare array or a { signals: [...] } wrapper to a plain array.
  if ! collected="$(jq -c '
        if type == "array" then .
        elif (type == "object" and (.signals | type) == "array") then .signals
        else error("not signals/v1")
        end' "$collect_out" 2>/dev/null)"; then
    err "collect-command output is not signals/v1 (expected a JSON array or an object with a 'signals' array)."
    exit 1
  fi

  # Client-side shape check — fails faster than the Dispatcher's own re-validation.
  reason="$(printf '%s' "$collected" | signals_invalid_reason)"
  if [ -n "$reason" ]; then
    err "collected signals are invalid: ${reason}"
    exit 1
  fi

  # Merge: caller-provided signals first, then collected. Re-check the combined
  # 50-item cap (each side can be ≤50 yet exceed it together).
  INPUTS="$(jq -c --argjson collected "$collected" '
    .signals = ((.signals // []) + $collected)' <<<"$INPUTS")"
  merged_count="$(jq '.signals | length' <<<"$INPUTS")"
  if [ "$merged_count" -gt 50 ]; then
    err "merged signals exceed the 50-item cap (${merged_count}). Cluster per failure, don't enumerate raw events."
    exit 1
  fi

  # A signals run (e.g. ci-triage-pr) keys on firedAt; default it to now (ms)
  # when signals are present but the caller didn't set one.
  now_ms="$(date +%s)000"
  INPUTS="$(jq -c --argjson now "$now_ms" '
    if ((.signals // []) | length) > 0 and (has("firedAt") | not)
    then .firedAt = $now else . end' <<<"$INPUTS")"
}

# --- notify recipients -------------------------------------------------------
# Accept a JSON array or a comma/whitespace-separated string; print a JSON array
# of non-empty entries. Pure.

normalize_notify() {
  local raw="$1"
  if [ -z "$raw" ]; then
    printf '[]'
  elif jq -e 'type == "array"' >/dev/null 2>&1 <<<"$raw"; then
    jq -c '[.[] | select(. != "")]' <<<"$raw"
  else
    jq -Rc 'split("[,\\s]+"; "") | map(select(length > 0))' <<<"$raw"
  fi
}

# --- assemble the body -------------------------------------------------------
# installation_id is OMITTED when unset/0 — the dispatch schema is
# `positive | undefined` (a literal 0 is a 400), and the Dispatcher resolves it
# server-side from the App's webhook-registered installation map when absent.
# Writes the compact JSON (newlines stripped) to $BODY_FILE.

assemble_body() {
  local install_id run_id github_ctx trigger_ctx emails
  install_id="$(to_uint "${INPUT_INSTALLATION_ID:-0}")"
  run_id="$(to_uint "${GITHUB_RUN_ID:-0}")"
  emails="$(normalize_notify "${INPUT_NOTIFY_EMAILS:-}")"

  github_ctx="$(jq -cn \
    --arg repo "${GITHUB_REPOSITORY:-}" \
    --arg ref "${GITHUB_REF:-refs/heads/main}" \
    --arg sha "$SHA" \
    --arg actor "${GITHUB_ACTOR:-}" \
    --argjson iid "$install_id" \
    '{ repo: $repo, ref: $ref, sha: $sha }
     + (if $actor != "" then { actor: $actor } else {} end)
     + (if $iid > 0 then { installation_id: $iid } else {} end)')"

  trigger_ctx="$(jq -cn \
    --argjson rid "$run_id" \
    --arg job "${GITHUB_JOB:-}" \
    '{}
     + (if $rid > 0 then { workflow_run_id: $rid } else {} end)
     + (if $job != "" then { job_id: $job } else {} end)')"

  mktmp BODY_FILE
  jq -cn \
    --arg run "$INPUT_RUN" \
    --argjson github "$github_ctx" \
    --argjson inputs "$INPUTS" \
    --argjson trigger "$trigger_ctx" \
    --argjson emails "$emails" \
    '{ run: $run, github: $github, inputs: $inputs, trigger: $trigger }
     + (if ($emails | length) > 0 then { notify: { emails: $emails } } else {} end)' \
    | tr -d '\n' >"$BODY_FILE"
}

# --- sign the exact bytes ----------------------------------------------------
# openssl reads the body from the FILE (never a here-string, which would append
# a newline and change the signature). stdin form (not a filename arg) so
# openssl emits no `HMAC-SHA256(file)=` prefix; `$NF` also tolerates the
# `(stdin)=` prefix older openssl prints. Sets $SIGNATURE and $LOCAL_FP.

sign_body() {
  local file="$1" sig_hex
  sig_hex="$(openssl dgst -sha256 -hmac "$INPUT_HMAC_SECRET" <"$file" | awk '{ print $NF }')"
  SIGNATURE="sha256=${sig_hex}"
  LOCAL_FP="$(printf '%s' "$INPUT_HMAC_SECRET" | openssl dgst -sha256 | awk '{ print $NF }' | cut -c1-8)"
}

# --- idempotency key + URL ---------------------------------------------------
# {run}[-{checkLabel}]-{repo}-{sha12}[-attempt-{N}] so the POST retries of one
# step collapse onto one execution at the receiver, while two steps dispatching
# one run with different `checkLabel`s stay two executions — the label names a
# separate check-run, so collapsing them would leave the second check never
# posted. A GitHub "Re-run jobs" (GITHUB_RUN_ATTEMPT > 1) appends
# `-attempt-<N>`: the Dispatcher keeps every id it has seen, so without the
# suffix a re-run is acknowledged with the prior execution's id and nothing
# runs. The check-run name comes from `checkLabel`, not the key, so the new
# execution's check supersedes the red one. Attempt 1 keeps the bare key.
# Randomized fallback when repo/sha are absent (local act runs).
# Sets $IDEMPOTENCY_KEY and $URL.

# Print `-<checkLabel>` when the inputs JSON on stdin carries a string
# `checkLabel`, else nothing. Pure.
check_label_suffix() {
  jq -r 'if (.checkLabel | type) == "string" and (.checkLabel | length) > 0
         then "-\(.checkLabel)" else "" end'
}

compute_targets() {
  if [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "$SHA" ]; then
    local repo_safe="${GITHUB_REPOSITORY//\//_}" label
    label="$(check_label_suffix <<<"${INPUTS:-null}")"
    IDEMPOTENCY_KEY="${INPUT_RUN}${label}-${repo_safe}-${SHA:0:12}"
    local attempt="${GITHUB_RUN_ATTEMPT:-1}"
    if [[ "$attempt" =~ ^[0-9]+$ ]] && [ "$attempt" -gt 1 ]; then
      IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY}-attempt-${attempt}"
    fi
  else
    IDEMPOTENCY_KEY="${INPUT_RUN}-$(date +%s)-${RANDOM}"
  fi
  local run_enc
  run_enc="$(jq -rn --arg r "$INPUT_RUN" '$r | @uri')"
  URL="${ENDPOINT}/v1/dispatch/${run_enc}"
}

# --- POST with bounded retry -------------------------------------------------
# 3 attempts total; 401/400/404 are permanent (no retry). Transient (000/429/
# 5xx) backs off attempt*base ms. base overridable via FLARE_RETRY_BACKOFF_MS.
# Sets $resp; breaks on 202, exits non-zero on a permanent / exhausted failure.

post_with_retry() {
  local base_backoff_ms max_attempts attempt curl_rc delay dispatcher_fp
  base_backoff_ms="${FLARE_RETRY_BACKOFF_MS:-5000}"
  max_attempts=3
  attempt=0
  resp=""
  mktmp RESP_FILE

  while :; do
    attempt=$((attempt + 1))
    set +e
    http_code="$(curl -sS \
      -o "$RESP_FILE" \
      -w '%{http_code}' \
      -X POST "$URL" \
      -H 'Content-Type: application/json' \
      -H "X-FlareDispatch-Signature: ${SIGNATURE}" \
      -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
      --data-binary "@${BODY_FILE}")"
    curl_rc=$?
    set -e
    if [ "$curl_rc" -ne 0 ]; then http_code=000; fi
    resp="$(cat "$RESP_FILE" 2>/dev/null || true)"

    case "$http_code" in
      202) break ;;
      401)
        err "FlareDispatch dispatch failed (HTTP 401): ${resp}"
        dispatcher_fp="$(jq -r '.dispatcher_secret_fingerprint // "<not provided>"' <<<"$resp" 2>/dev/null || echo '<not provided>')"
        err "HMAC drift between flare-dispatch-action and the Dispatcher Worker."
        note "  local secret fingerprint      = ${LOCAL_FP}"
        note "  dispatcher secret fingerprint = ${dispatcher_fp}"
        note "  If they differ, re-sync HMAC_SECRET on the mismatching side (a trailing newline is the usual culprit)."
        exit 1
        ;;
      400 | 404)
        err "FlareDispatch dispatch failed (HTTP ${http_code}): ${resp}"
        exit 1
        ;;
      *)
        if [ "$attempt" -ge "$max_attempts" ]; then
          err "FlareDispatch dispatch failed after ${attempt} attempts (last HTTP ${http_code}): ${resp}"
          exit 1
        fi
        delay="$(awk -v ms="$((attempt * base_backoff_ms))" 'BEGIN { printf "%.3f", ms / 1000 }')"
        note "FlareDispatch: transient failure (HTTP ${http_code}), retry ${attempt}/$((max_attempts - 1)) in ${delay}s..."
        sleep "$delay"
        ;;
    esac
  done
}

# --- parse the 202 + emit outputs --------------------------------------------

emit_outputs() {
  local execution_id details_url logs_url skipped
  execution_id="$(resp_field executionId)"
  details_url="$(resp_field detailsUrl)"
  logs_url="$(resp_field logsUrl)"
  skipped="$(jq -r '.skipped // ""' <<<"$resp" 2>/dev/null || true)"

  if [ "$skipped" = "cooldown" ]; then
    note "FlareDispatch: '${INPUT_RUN}' within its cooldown window — reusing execution ${execution_id} (no new run)."
  else
    note "FlareDispatch: dispatched '${INPUT_RUN}' — executionId=${execution_id}"
  fi
  [ -n "$details_url" ] && note "FlareDispatch: Cloudflare Workflows run — ${details_url}"
  [ -n "$logs_url" ] && note "FlareDispatch: full logs — ${logs_url}"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'execution-id=%s\n' "$execution_id"
      printf 'details-url=%s\n' "$details_url"
      printf 'logs-url=%s\n' "$logs_url"
    } >>"$GITHUB_OUTPUT"
  fi
}

# --- orchestration -----------------------------------------------------------

main() {
  require_deps jq openssl curl
  assert_mode
  validate_inputs
  SHA="$(resolve_head_sha)"
  load_inputs_json
  fold_in_signals
  assemble_body
  sign_body "$BODY_FILE"
  compute_targets
  post_with_retry
  emit_outputs
}

# Run only when executed, not when sourced — so dispatch.bats can source this
# file and exercise the pure helpers in isolation.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  trap cleanup EXIT
  main "$@"
fi
