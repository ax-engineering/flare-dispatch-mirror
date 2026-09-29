# flare-dispatch-action

Composite GitHub Action that dispatches a [FlareDispatch](../../README.md) run.
It HMAC-signs a dispatch body and POSTs it to your Dispatcher Worker; the run
executes **asynchronously on Cloudflare** and reports its result back to the PR
via a `flare-dispatch/<run>` **check-run** — not via this step.

It's a pure composite action (`bash` + `openssl` + `curl` + `jq`, all
preinstalled on GitHub-hosted runners). Nothing to `npm install`, no bundled
runtime to keep in sync — the logic is in [`dispatch.sh`](./dispatch.sh). Runs in
seconds on a normal hosted runner; no `self-hosted`, no PAT.

## Usage

```yaml
# .github/workflows/ci.yml
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: offload-test
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      { "repo": "${{ github.repository }}", "sha": "${{ github.sha }}", "command": "pnpm test" }
    mode: fire-and-forget
```

Pin the action by commit SHA (`@<sha>`), not `@main` — a moving ref is not
reproducible.

In branch protection, require the **check-run** name (e.g.
`flare-dispatch/offload-test`), not this GHA job — the check-run is the real PR
signal. The step itself succeeds the moment the dispatch is accepted (`202`).

The Dispatcher creates the Workflow instance before it answers `202`; the run
and its check-run happen after the step has already finished.

```mermaid
sequenceDiagram
    accTitle: From dispatch to check-run verdict
    participant A as flare-dispatch-action
    participant D as Dispatcher Worker
    participant W as RunWorkflow
    participant G as GitHub Checks
    A->>D: POST /v1/dispatch/‹run› with signature + Idempotency-Key
    D->>D: verify HMAC, look up run, validate inputs
    D->>W: create instance, id = executionId
    D-->>A: 202 executionId, detailsUrl, logsUrl
    Note over A: step green, outputs written
    W->>G: open flare-dispatch/‹run› check-run, in_progress
    W->>W: execute the run
    W->>G: complete check-run with success, failure or neutral
```

## Inputs

| Input             | Required | Default           | Notes                                                                                                                                                                                          |
| ----------------- | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`             | yes      | —                 | Run slug. Must exist on the target Dispatcher deploy.                                                                                                                                          |
| `endpoint`        | yes      | —                 | Dispatcher base URL, e.g. `https://flare-dispatch.<account>.workers.dev`.                                                                                                                      |
| `hmac-secret`     | yes      | —                 | Shared HMAC secret. Same value as the Worker's `HMAC_SECRET`.                                                                                                                                  |
| `inputs`          | no       | `{}`              | JSON object of run inputs. Validated against the run's Schema on the Worker side.                                                                                                              |
| `collect-command` | no       | `""`              | Optional consumer-side observability collector — see [Collecting signals](#collecting-signals-collect-command).                                                                                |
| `mode`            | no       | `fire-and-forget` | **V0 supports `fire-and-forget` only.** Any other value fails the step before the network is touched.                                                                                          |
| `installation-id` | no       | `0`               | GitHub App installation id for the target repo. Optional — a Dispatcher that has seen this repo resolves it server-side. `0` is treated as unset.                                              |
| `notify-emails`   | no       | `""`              | Optional recipients emailed the run's result on completion. Comma/whitespace separated or a JSON array. Each must be a verified Cloudflare Email Routing destination on the Dispatcher's zone. |

## Outputs

| Output         | Notes                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `execution-id` | ULID of the execution on Cloudflare. Always set — the Dispatcher returns it in the `202`.                                       |
| `details-url`  | Cloudflare Workflows instance URL for the execution (steps/logs). Empty under BYOC or on older Dispatchers.                     |
| `logs-url`     | Tokened, live-refreshing log-viewer URL on the Dispatcher's own origin. Empty when the Dispatcher has no log-link key material. |

## How the PR head SHA is resolved

On `pull_request` / `pull_request_target` events `GITHUB_SHA` is the ephemeral
test-**merge** commit; a check-run posted there is invisible on the PR head and
branch protection can't gate it. The action reads `pull_request.head.sha` from
the event payload so the verdict lands on the commit the author pushed, falling
back to `GITHUB_SHA` for push events. The same head SHA keys the
`Idempotency-Key`, so the action's own POST retries collapse onto one execution
per head commit. An `inputs.checkLabel` joins the key
(`<run>-<label>-<repo>-<sha12>`), so two steps dispatching one run with
different labels stay two executions.

A GitHub **Re-run jobs** on the workflow (`GITHUB_RUN_ATTEMPT` > 1) appends
`-attempt-<N>` to the key and dispatches a fresh execution; its check-run keeps
the same name and supersedes the earlier one. This is the retry path for a check
that failed on a platform fault (a container evicted mid-run) when the App's
webhook — and with it the check-run's own **Re-run** button — is not configured.
The dispatching job is green after a `202`, so use **Re-run all jobs**, not
**Re-run failed jobs**.

## Collecting signals (`collect-command`)

A run such as `ci-triage-pr` can triage **signals** — observability findings the
Dispatcher's own read capabilities can't reach (an APM/tracing SaaS, runtime
exception logs, health probes). The Dispatcher never queries those vendors;
instead you point `collect-command` at a **consumer-side collector** that prints
the [`signals/v1`](../../schemas/signals.v1.schema.json) shape, and the action
folds its output into the dispatch.

```yaml
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: ci-triage-pr
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    # Your collector. Prints ONLY signals/v1 JSON to stdout, exits 0.
    collect-command: node scripts/collect-observability-errors.mjs
```

Contract for the command:

- **stdout is ONLY the JSON payload** — a bare `Signal[]` array, or an object
  with a `signals` array property. Diagnostics go to **stderr** (passed through
  to the runner log).
- **Exit 0** with a valid (possibly empty) array. A non-zero exit, or output
  that isn't valid `signals/v1`, **fails the Action before signing** — the
  collector is broken; better to surface that than dispatch silently.
- **Respect the caps**: ≤ 50 items; `source` ≤ 120, `title` ≤ 200, `detail` ≤
  2000, `url` ≤ 1000 chars; `source`/`title`/`detail` required. Cluster (one
  signal per failure cluster), don't enumerate raw events.

Collected signals are appended to any `signals` already in `inputs`
(caller-provided first), re-validated against the 50-item cap, and — because a
signals run keys on it — a `firedAt` (epoch ms) is defaulted to "now" when the
merged inputs carry signals but no `firedAt`. The machine-readable contract is
[`schemas/signals.v1.schema.json`](../../schemas/signals.v1.schema.json).

## Failure handling

Per [`specs/04-gha-integration.md` § Failure handling](../../specs/04-gha-integration.md):

```mermaid
flowchart TB
    accTitle: How the step handles each response
    post["**POST the signed body**<br/>same bytes every attempt"] --> code{"HTTP status"}
    code -->|202| ok["**Step green**<br/>execution-id written"]
    code -->|401| drift["**Fail, no retry**<br/>both secret fingerprints printed"]
    code -->|"400 / 404"| cfg["**Fail, no retry**<br/>Dispatcher error inlined"]
    code -->|"any other, incl. network error"| more{"attempts < 3?"}
    more -->|yes| wait["sleep attempt × 5s"]
    wait --> post
    more -->|no| gaveup["**Fail**<br/>last status inlined"]
    class ok ok
    class drift,cfg,gaveup danger
```

- **Dispatcher unreachable / `429` / `5xx`** — retried with backoff, 3 attempts in total; every status other than `202`, `400`, `401` and `404` (including a `403` refusal) counts as transient
  (`attempt × 5s`, override via `FLARE_RETRY_BACKOFF_MS`), then the step fails.
- **`401`** (HMAC rejected) — config bug; the step fails immediately, no retry.
  The job log prints two 8-char fingerprints (`sha256(secret)[:8]`):

  ```
  HMAC drift between flare-dispatch-action and the Dispatcher Worker.
    local secret fingerprint      = 1f3a9c2e
    dispatcher secret fingerprint = 1f3a9c2f
  ```

  Compare them — if they differ, re-sync the secret on the mismatching side
  (`gh secret set FLAREDISPATCH_HMAC` or `wrangler secret put HMAC_SECRET`). A
  trailing newline pasted into one side and not the other is the dominant cause.

- **`400`** (inputs fail the run Schema) / **`404`** (unknown run) — the step
  fails immediately with the Dispatcher's error inlined.
- **`collect-command`** non-zero exit or invalid output — the step fails
  **before** any network call, with the collector's stderr tail (non-zero exit)
  or the validation reason (malformed `signals/v1` output) inlined. No dispatch
  is signed or sent.

A dispatch that lands inside a run's cooldown window is acknowledged (`202`)
with the prior execution's id and `skipped: "cooldown"` — the step stays green
and `execution-id` still points at a real execution.
