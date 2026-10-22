# FlareDispatch run catalog

Starter runs shipped in `@fractalboxdev/flare-dispatch-runs`. The Dispatcher
registers them by name; Action mode dispatches via
[`flare-dispatch-action`](../actions/flare-dispatch-action/), webhook mode fires
from each run's `triggers`.

## From trigger to check-run

All three trigger sources end in one `RUNS_WORKFLOW.create`, keyed by the run's
instance id; everything after that runs inside the Workflow.

```mermaid
flowchart TB
  accTitle: Trigger sources reaching a run's Workflow
  gha["**GitHub Actions**<br/>flare-dispatch-action"] -->|"POST /v1/dispatch/:run"| disp
  app["**GitHub App webhook**<br/>pull_request, check_suite"] -->|"POST /v1/webhooks/github"| disp
  cron["**Cron Trigger**"] -->|"scheduled()"| disp
  disp["**Dispatcher Worker**<br/>verify, dedup, gate, cooldown"] -->|"RUNS_WORKFLOW.create"| wf["**RunWorkflow**<br/>one instance per execution"]
  wf --> box["**Container**<br/>clone, install, exec"]
  wf --> r2[("**R2**<br/>logs, artifacts, dep cache")]
  wf --> checks["**check-run**<br/>flare-dispatch/*"]
  class disp accent
  class checks ok
```

A cron tick carries no commit. A scheduled run whose inputs name a `repo` and a
`refs/heads/<branch>` ref, and no `sha`, is pinned at the tick to that branch's
head through the repo's GitHub App installation: the run receives the commit as
`inputs.sha`, and its `flare-dispatch/<run>` check-run opens on that commit when
the run starts and concludes with the run's outcome. A failure's summary names
the failing step and its error tag. A repo without the App installed, or a
deploy without App credentials, runs the schedule and posts no check-run.

A run is a recipe: it composes primitives, which ride the capability layer, and
calls capabilities directly where no primitive fits.

```mermaid
flowchart TB
  accTitle: The layers a PR run is built from
  subgraph recipes["recipes (runs/)"]
    check["check"]
    offload["offload-test"]
    deploy["worker-deploy"]
  end
  subgraph prims["primitives"]
    ensure["ensureWorkspace"]
    ws["workspace"]
    install["installCached"]
    load["loadSecrets"]
  end
  subgraph caps["capabilities"]
    sandbox["sandbox"]
    cache["cache"]
    secrets["secrets"]
    other["config, artifact, github, io"]
  end
  recipes --> prims
  recipes --> other
  ensure --> ws
  ws --> install
  ws --> sandbox
  install --> cache
  load --> secrets
```

Every execution passes the same gates around its run body, and every exit —
a gate timeout included — completes the check-run it opened.

```mermaid
flowchart TB
  accTitle: One execution inside RunWorkflow
  open["**check-run opens**<br/>in_progress"] --> sup{"run declares<br/>supersede?"}
  sup -->|yes| rank{"higher-ranked<br/>member live?"}
  rank -->|yes| stood["**stand down**<br/>cancelled"]
  rank -->|no| cancel["**supersede**<br/>cancel lower-ranked members"]
  sup -->|no| ser{"run declares<br/>serialize?"}
  cancel --> ser
  ser -->|yes| serial["**serial gate**<br/>one execution per group"]
  ser -->|no| adm
  serial --> adm["**admission**<br/>per-pool slot, FIFO"]
  adm --> lease["**container lease**"]
  lease --> body["**run body**<br/>durable steps"]
  body --> destroy["**destroy container**"]
  destroy --> exit{"run exit"}
  exit -->|success| ok["**success**"]
  exit -->|RunSkipped| neutral["**neutral**<br/>skip reason as summary"]
  exit -->|failure| red["**failure**"]
  serial -->|superseded| neutral
  serial -->|SerialQueueTimedOut| red
  adm -->|AdmissionTimedOut| red
  class ok ok
  class neutral muted
  class red danger
```

## Finding your logs

Three layers, closest first:

1. **The check-run summary** (PR → Checks tab). Every check-run — in-progress
   and completed, green and red, on every dispatch path — carries up to two
   links: **"view full logs ↗"** opens the readable log viewer
   (`<origin>/logs/<instance-id>?t=<token>`; the token is signed with
   `LOG_LINK_SECRET`, falling back to `HMAC_SECRET`, and the link is omitted
   when neither secret is set), and **"view step logs in Cloudflare ↗"** opens
   the Workflows instance page (present only when `CLOUDFLARE_ACCOUNT_ID` is
   set, and needs dashboard access to your account). The dispatcher's own
   dashboard at `GET /` (Cloudflare Access-gated) lists recent executions with
   the same tokened viewer links — the browse path when you don't have the PR
   open. Cron-scheduled runs have no request to infer an origin from, so their
   viewer links need the `PUBLIC_ORIGIN` var.
2. **The Workflows step timeline.** The instance id is the semantic key with
   disallowed chars mapped to `_`, e.g. `check_owner_repo_<sha12>`:

   ```bash
   wrangler workflows instances describe runs-workflow check_owner_repo_<sha12>
   ```

3. **Raw artifacts** at `GET <origin>/v1/artifacts/<instance-id>/<name>`. The
   captured command log is a normal artifact; the name is per run — `check` →
   `check.log`, `offload-test` / `worker-deploy` → `step.log`, `oxlint` →
   `oxlint.log`, `playwright-demo` → `playwright.log`.

A command's log is uploaded **after** the command completes — a run killed
mid-command (timeout at the Workflow layer, container eviction) leaves no log
artifact behind. For `offload-test`, per-stage exec steps
([#82](https://github.com/fractalboxdev/flare-dispatch/pull/82)) split the run
into `step-<label>.log` uploads so earlier stages' logs survive a later stage's
death.

## Re-running a check

GitHub's **Re-run** button on a `flare-dispatch/*` check-run re-dispatches the
execution that posted it — same run, repo, commit, and recorded inputs — so a
check that went red because the platform killed its container is retried
without a new commit. **Re-run all checks** on the suite re-runs every check at
that commit whose latest attempt did not pass; green checks are left alone.

```mermaid
flowchart TB
  accTitle: Re-run decision for one check
  click_["**Re-run** on a check-run"] --> app{"this deploy's<br/>GitHub App?"}
  app -->|no| r1["refused<br/>foreign_app"]
  app -->|yes| known{"an execution here<br/>posted it?"}
  known -->|no| r2["refused<br/>unknown_check_run"]
  known -->|yes| live{"an attempt still<br/>queued or running?"}
  live -->|yes| r3["refused<br/>in_progress"]
  live -->|no| reg{"run registered,<br/>inputs decode?"}
  reg -->|no| r4["refused<br/>run_not_registered,<br/>inputs_unreplayable"]
  reg -->|yes| cap{"attempt 5<br/>reached?"}
  cap -->|yes| r5["refused<br/>attempts_exhausted"]
  cap -->|no| go["**dispatch attempt N**<br/>`_attempt-N` instance id"]
  class r1,r2,r3,r4,r5 muted
  class go ok
```

- **Attempts.** A re-run is a new execution: Cloudflare Workflows never reuses
  an instance id, so attempt N runs as `<first-instance-id>_attempt-<N>`
  (hash-truncated past 64 chars, like every instance id).
  `GET /v1/executions/:id` reports `attempt` and, on a re-run, `retryOf` — the
  first attempt's id. The check-run keeps its name, so branch protection counts
  the newest attempt; its title reads `flare-dispatch/<run> (attempt N)`.
- **One at a time.** A re-run is refused while any attempt of the same check is
  still queued or running, per the Workflow instance's own status — repeated
  clicks dispatch nothing more. An execution left `running` by a Workflow that
  died does not block.
- **Bounded.** Five attempts per check, the first dispatch included. A re-run
  bypasses the run's `cooldown`, which caps push storms, not explicit retries.
- **Not replayed.** Completion-notify emails and a Slack origin are not recorded
  on the execution, so a re-run reports on the check-run only.

The webhook answers `202` with a `rerun` array stating, per check, whether it
dispatched (`executionId`, `attempt`) or why it refused (`foreign_app`,
`unknown_check_run`, `in_progress`, `attempts_exhausted`,
`run_not_registered`, `inputs_unreplayable`). Re-runs need the App subscribed to
the **Check run** and **Check suite** events, which the app manifest requests.

## `check` — universal command gate (opt-out by default)

Configurable PR gate for repos that do **not** want the hardcoded Oxc/`oxlint`
run. Clone → run one operator-supplied command → upload log → green/red
`flare-dispatch/check`.

Use this for `pnpm lint`, `npx eslint .`, `npx biome check .`,
`cargo clippy --workspace`, `ruff check`, etc.

Prefer [`oxlint`](./oxlint.ts) when you want the install-free Oxc gate with no
per-repo opt-in.

### Opt-in (required for webhook mode)

Absent a command, the run **no-ops green** with `skippedReason: "not-configured"`
— no clone, no container burn. There is no dispatcher-wide default command
(unlike `offload-test`).

```bash
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo" "pnpm lint"
```

Do **not** require `flare-dispatch/check` in branch protection until that key is
set — an unconfigured skip would otherwise satisfy the required check.

### Several gates on one repo

A repo usually has more than one deterministic check worth requiring — a source
guard, `shellcheck`, a codegen-drift check. Dispatch `check` once per gate with
a distinct `checkLabel`; each lands as its own check-run
(`flare-dispatch/check:<label>`) and is separately requirable in branch
protection. Without a label they would all be named `flare-dispatch/check`,
which branch protection cannot tell apart.

```bash
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo:lint-shell" "shellcheck scripts/*.sh"
wrangler kv key put --binding=CONFIG_KV \
  "check.command:owner/repo:codegen" "pnpm generate && git diff --exit-code"
```

A labelled dispatch reads `check.command:<repo>:<label>` and falls back to
`check.command:<repo>`, so adding a second gate never requires re-keying the
first. The fallback does not run in reverse: an **unlabelled** dispatch reads
only `check.command:<repo>`, so configuring a labelled gate never silently opts
the webhook-triggered default gate in.

The webhook trigger fires the unlabelled gate only — a trigger's `inputs`
callback is sync and payload-only, so it cannot enumerate a repo's labels from
KV. Labelled gates are dispatched Action-mode, one step per gate.

### Action mode

Pass `command` in the dispatch body (skips KV). Set `install: true` when the
command needs `node_modules` / a lockfile install.

```yaml
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: check
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      {
        "repo": "${{ github.repository }}",
        "sha": "${{ github.sha }}",
        "command": "pnpm lint",
        "install": true,
        "failOnNonZeroExit": true
      }
```

### Inputs

| Field               | Default  | Notes                                                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `repo`              | required | `owner/name`                                                                                         |
| `sha`               | required | commit to checkout                                                                                   |
| `command`           | omit     | shell command; webhook resolves `check.command:<repo>`                                               |
| `checkLabel`        | omit     | names a second/third gate — see _Several gates on one repo_. `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`       |
| `install`           | `false`  | R2-cached dep install after clone                                                                    |
| `image`             | omit     | container image override                                                                             |
| `env`               | omit     | **non-sensitive only** — dispatch inputs are persisted                                               |
| `secrets`           | `[]`     | Worker-secret **names** injected into the command env via `loadSecrets` (inline, never checkpointed) |
| `secretPrefix`      | omit     | deprecated / ignored — Worker bindings are bare names (kept for `offload-test` parity)               |
| `timeoutSec`        | `600`    | `sandbox.exec` timeout                                                                               |
| `failOnNonZeroExit` | `false`  | Action default; webhook trigger sets `true`                                                          |

### Webhook behavior

- Event: `pull_request` (`opened` / `synchronize` / `reopened` / `ready_for_review`)
- Skips drafts and `dependabot[bot]`
- Idempotency key: `check:{repo_}:{sha12}`
- `failOnNonZeroExit: true` — the check-run is the only pass/fail signal

### Outputs

| Field           | Notes                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `exitCode`      | `0` when skipped                                                                     |
| `durationMs`    | from checkpointed exec; `0` when skipped                                             |
| `logUri`        | signed R2 URL to `check.log` (30-day TTL, same as sibling runs); absent when skipped |
| `skippedReason` | `"not-configured"` when opted out                                                    |

### Secrets and logs

- Name credentials in `secrets` (e.g. `["NPM_TOKEN"]`). Values come from Worker
  secrets (`wrangler secret put NPM_TOKEN`) via `loadSecrets` — resolved
  **inline**, before the container is even provisioned, so a missing secret
  fails fast and plaintext never lands in a Workflow checkpoint. Per-dispatch
  `env` wins over a same-named secret.
- Do **not** put credentials in `env` or the command string — dispatch inputs
  and Workflow params are persisted.
- **Trust boundary**: the `pull_request` webhook trigger never carries
  `secrets` (hard-coded empty, no per-repo CONFIG_KV fallback) — a fork PR can
  never trigger a secret-bearing dispatch on its own. `secrets` only reaches
  the command via an explicit **Action-mode** dispatch that your own CI
  controls. That command still runs against the caller-selected `sha`, so —
  same guidance GitHub gives for `pull_request_target` + secrets — do **not**
  wire an Action-mode `check` dispatch with `secrets` into a workflow that
  triggers on `pull_request` for a repo that accepts external/fork PRs.
- Stdout/stderr land in `check.log` behind a signed URL (catalog-wide 30-day
  TTL). Every resolved secret **value** is scrubbed from that log (and from
  the inline preview) before upload as defense in depth — but this is a
  substring redaction, not a guarantee: a command that re-encodes a credential
  (base64, split across lines, etc.) before printing it can still leak it. Do
  not print tokens or personal data from the check command.

```yaml
# Action mode — private registry / authenticated tool. Only wire this into a
# workflow trigger you trust with the named secret (see trust boundary above).
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: check
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      {
        "repo": "${{ github.repository }}",
        "sha": "${{ github.sha }}",
        "command": "pnpm lint",
        "install": true,
        "secrets": ["NPM_TOKEN"],
        "failOnNonZeroExit": true
      }
```

## `oxlint` — install-free Oxc gate, on a version pinned in the run

Clone → `npx --yes oxlint@<version>` → upload log → green/red
`flare-dispatch/oxlint`. No install, no per-repo command, no `.oxlintrc.json`
required, so it is droppable on any repo.

The version is an **exact pin** in [`oxlint.ts`](./oxlint.ts) (`VERSION_DEFAULT`),
not a range and not a dist-tag. It was the major line `1` until 2026-08-18, when
oxlint 1.79.0 moved five React rules into the `correctness` category: because
oxlint selects rules by category, every consumer tracking `@1` went red within
the hour, on every open PR at once, for findings that predated all of them —
and no consumer could fix it, because the version lives here. The same release
left each repo's own `pnpm lint` green, since that runs the repo's pinned
devDependency; a floating gate means the two lanes enforce different rule sets
and nothing says so until they disagree.

Bumping `VERSION_DEFAULT` can turn consumers red, so it belongs in its own PR.

### Pinning one repo (`oxlint.version:<repo>`)

A repo that a bump breaks — or one that wants a newer oxlint before the default
moves — sets its own version without waiting on a deploy:

```bash
wrangler kv key put --binding=CONFIG_KV \
  "oxlint.version:owner/repo" "1.74.0"
```

Resolution is dispatch input → `oxlint.version:<repo>` → the dispatcher-wide
`oxlint.version` → `VERSION_DEFAULT`. An Action-mode dispatch that passes
`version` skips the lookup entirely (and the `resolve-version` step with it).
Set an exact version: a range here re-resolves on every run and reinstates the
same problem one repo at a time.

## `offload-test` — webhook mode needs two CONFIG_KV keys to run a real suite

`offload-test`'s `pull_request` trigger can only pass what it computes from the
PR payload, so a webhook dispatch historically ran with `install: false` and the
600s default timeout. That is fine for a source-only command and unusable for
the case the run exists to serve — a repo's actual test suite, which needs its
dependency tree and routinely outruns ten minutes.

Both are now resolvable per repo. They are a pair: a suite that needs an install
almost always needs the longer ceiling too.

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.command:owner/repo"    "pnpm -r --if-present test"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.install:owner/repo"    "true"     # "true"/"1" | "false"/"0"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.timeoutSec:owner/repo" "1800"     # positive integer
```

Precedence is dispatch value → CONFIG_KV → default (`install: false`,
`timeoutSec: 600`). An Action-mode dispatch that passes a value always wins, and
one that passes `command` skips the config read entirely.

A malformed value degrades to the default rather than propagating: a non-integer
timeout would otherwise reach `sandbox.exec` as `NaN` — a timeout that never
fires, i.e. a hung run holding a container indefinitely.

`timeoutSec` is enforced per exec by the sandbox's own deadline. The run's
`maxDurationSec` (3600) bounds the whole body above it: the dispatcher fails the
run `RunDurationExceeded` once the ceiling elapses from the body's start, and the
exec's retries draw on that same budget.

```mermaid
flowchart TB
  accTitle: offload-test single-exec flow and verdicts
  resolve["**resolve-command**<br/>dispatch, then CONFIG_KV"] --> staged{"stages<br/>configured?"}
  staged -->|yes| stages["**staged mode**<br/>below"]
  staged -->|no| cmd{"command<br/>resolved?"}
  cmd -->|"no, webhook"| skip["**neutral**<br/>no command configured"]
  cmd -->|"no, Action"| bad["**failure**<br/>StepFailed"]
  cmd -->|yes| checkout["**checkout**<br/>clone, optional install"]
  checkout --> exec["**exec**<br/>ensureWorkspace, then sandbox.exec<br/>3 retries on ExecFailed, StepFailed"]
  exec --> upload["**upload-log**<br/>step.log"]
  upload --> code{"exit code"}
  code -->|0| ok["**success**"]
  code -->|"non-zero, failOnNonZeroExit"| red["**failure**<br/>AcceptanceFailed"]
  code -->|"non-zero, Action default"| reported["**success**<br/>exitCode in output"]
  class skip muted
  class bad,red danger
  class ok,reported ok
```

### Credentials (`offload-test.secrets:<repo>`)

The trigger pins `secrets: []`, so a webhook dispatch cannot name a credential.
A repo whose suite needs one — a registry token so `pnpm install` can fetch a
private package, say — names it in CONFIG_KV and stores the value as a Worker
secret on the dispatcher:

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.secrets:owner/repo"       "NODE_AUTH_TOKEN"   # comma-separated env var NAMES
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.secret-prefix:owner/repo" "ci/"               # optional; deprecated, ignored by loadSecrets
wrangler secret put NODE_AUTH_TOKEN                           # the VALUE, on the dispatcher Worker
```

- Names are trimmed and empties dropped. They are read inside `resolve-command`,
  so only the names are checkpointed; values load inline with
  `loadSecrets({ required: true })`, and a named key with no Worker value fails
  the run with `SecretsMissing` before checkout.
- Dispatch-supplied `secrets` / `secretPrefix` win; the keys are the fallback
  when the dispatch named none. Per-repo only — there is no dispatcher-wide
  `offload-test.secrets`, so one repo's credentials never reach another's
  command.
- The values reach every exec path (single exec, sequential stages, isolated
  stages) under the dispatch `env`, and the dependency install inside
  `checkout` / each isolated stage's workspace. Every one of those execs scrubs
  the values from its log.
- Absent key → the run loads no secrets and its steps and checkpoints are
  unchanged.

### Staged mode (`offload-test.stages:<repo>`)

One long buffered exec killed by the platform takes its whole log with it
(issue #39). Three more config keys split the webhook-mode run into one exec step per
stage, each uploading its `step-<label>.log` immediately, so a later stage's
death cannot orphan an earlier stage's log:

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.stages:owner/repo"                "workspace,features,ts"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.command:owner/repo:features"      "pnpm test --filter features"
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.timeoutSec:owner/repo:ts"         "900"
```

- `offload-test.stages:<repo>` — comma-separated stage labels
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,31}` each). Absent → the single-exec behaviour,
  byte-identical. Present but malformed/empty/duplicated → the run fails loudly
  (a silent un-staging would resurrect the log-dies-with-the-step defect).
- `offload-test.command:<repo>:<label>` — per-stage command, falling back to
  the unlabelled `offload-test.command:<repo>` (the fallback is warned and
  flagged on the stage's step metadata). Two stages may share a command — a
  repo staging one command purely for the per-stage timeout and log split is
  a legitimate config, and the facade keys an exec's identity on the enclosing
  step as well as the command, so the stages stay distinct executions.
- `offload-test.timeoutSec:<repo>:<label>` — per-stage exec ceiling.

Per-stage timeout precedence: labelled key → dispatch `timeoutSec` →
unlabelled key → default (600). The labelled key outranks the dispatch value
— an inversion of the usual dispatch-wins rule — because staged mode only
exists when the dispatch omitted `command` (webhook mode), so a `timeoutSec`
riding such a dispatch is a coarse whole-run knob, and the stage-specific key
is the more specific source.

Staging makes earlier stages' logs durable; it does not give a long suite more
wall time. Each stage still runs under its own exec ceiling, and those per-exec
ceilings are the only runtime enforcement — size them to the suite.

Staged mode is webhook-only: a dispatch that passes `command` skips the config
read and stays single-exec. Stages run inside one workflow instance posting one
check-run — sequentially by default, concurrently when `offload-test.stageConcurrency:<repo>` says so.

```mermaid
flowchart TB
  accTitle: Sequential staged mode on one shared container
  checkout["**checkout**<br/>one shared container"] --> exec["**exec-{label}**<br/>ensureWorkspace, then exec<br/>3 retries"]
  exec -->|"step died"| marker["**marker log**<br/>step-{label}.log"]
  marker --> dead["**failure**<br/>later stages ⊘ skipped"]
  exec -->|"ran to an exit code"| upload["**upload-log-{label}**"]
  upload -->|"upload failed"| dead
  upload --> code{"exit code"}
  code -->|0| more{"more<br/>stages?"}
  more -->|yes| exec
  more -->|no| ok["**success**"]
  code -->|"non-zero"| red["**red stage**<br/>later stages ⊘ skipped<br/>failure when failOnNonZeroExit"]
  class dead,red danger
  class ok ok
```

### Container transport (`sandbox.transport:<repo>`)

Containers run on the SDK's `rpc` transport. The dispatcher resolves one
transport per execution and pins it onto every container the execution
acquires, highest first:

1. the `CONFIG_KV` key `sandbox.transport:<repo>`;
2. the Worker-wide `SANDBOX_TRANSPORT` var;
3. `rpc`.

Each level takes `http`, `websocket` or `rpc`. The pin overrides the var in
either direction, so one repo moves back to `http` without a deploy:

```bash
wrangler kv key put --binding=CONFIG_KV "sandbox.transport:owner/repo" "http"
```

Deleting the key returns the repo to the var, or to `rpc`. **A value that is not
a transport name is skipped at its level**, silently: a typo in the pin falls
through to the var, and one in the var falls through to `rpc`. Check the key
back if a transport change appears to have had no effect. The precedence lives
in `packages/runtime-cf/src/sandbox-transport.ts`.

**Why `rpc`.** The SDK's streaming file APIs live only on its `rpc` client —
its own comment calls `rpc` the "primary container-control client" and
`http`/`websocket` the "route-based compatibility client", and `writeFileStream`
is a bare `throw` off `rpc`. `installCached`'s restore hands `writeFile` a
`ReadableStream`, and the SDK routes any stream to `writeFileStream`, so off
`rpc` a stored archive cannot be applied. The R2 cache receives the resolved
transport: on `rpc` it streams the archive in; on `http` or `websocket` it reads
only the archive's head, reports `unapplied`, runs the install and skips the
save, so the run pays for neither the download nor a second upload.

**It is sticky.** `setTransport` persists to the container's Durable Object
storage, and the SDK prefers a stored transport over the env-derived default on
cold start. A container keeps the transport it started with for its lifetime;
since ids are per execution, a changed pin or var takes effect on the next run,
and the pin costs one DO call per container at acquire.

### A stage does not assume its checkout

Container disk is ephemeral, and a staged run spanning forty minutes of durable
steps is long enough for the instance behind it to be recycled. The runtime
reports that as `working directory '<dir>' was missing at exec time — the
checkout did not survive to this step (container recycled)`, raised as
`ExecFailed`.

`ExecFailed` is exactly what `retryOn` retries, so the platform re-ran the same
command in the same missing directory three times and reported a failure about a
missing directory rather than anything about the code. The retry could never
have worked: the thing it needed was the thing that was gone.

That classification is made where the failure is raised, not by reading the
message afterwards. The message embeds the missing `cwd`, and the runtime also
matches `/timeout/i` on it to spot an SDK timeout — so a checkout under a path
like `/workspace/request-timeout` used to land as `ExecTimeout`, which `retryOn`
excludes on purpose, and the step died without ever retrying.

So **every** PR run and every path within it — `offload-test` staged and
single-exec, `check`, and `oxlint` — calls the `ensureWorkspace` primitive
inside its retryable step: it
probes `test -d <dir>/.git` and re-clones when the probe fails. On the happy path
that is one extra exec of about a second; on a recycled container it is a clone
and an install, which is what the step was going to need anyway.

Because that re-clone runs inside the step, `retryOn` covers `CheckoutFailed`
alongside `ExecFailed` and `StepFailed`: a clone that flakes mid-recovery would
otherwise end the step one call short of the repair it was there to perform.

Isolated stages need no probe: they acquire a workspace inside the retryable
step already, so a retry rebuilds it by construction.

### Isolated stages (`offload-test.stageConcurrency:<repo>`)

```bash
wrangler kv key put --binding=CONFIG_KV \
  "offload-test.stageConcurrency:owner/repo"      "4"
```

Absent or `1` is the shared-container sequential mode above, byte for byte.
Above 1, each stage acquires its **own** container — `acquire({ key: <label> })`
— and up to N run at once.

```mermaid
flowchart TB
  accTitle: Isolated stages, each on its own container
  resolve["**resolve-command**<br/>stages, concurrency N"] --> a1
  resolve --> b1
  subgraph sa["stage a"]
    a1["**exec-a**<br/>acquire key a, clone, exec<br/>3 retries"] --> a2["**upload-log-a**"]
    a2 --> a3["destroy container a"]
  end
  subgraph sb["stage b"]
    b1["**exec-b**<br/>acquire key b, clone, exec<br/>3 retries"] --> b2["**upload-log-b**"]
    b2 --> b3["destroy container b"]
  end
  a3 --> any{"any stage died,<br/>lost its log, or went red?"}
  b3 --> any
  any -->|no| ok["**success**"]
  any -->|yes| red["**failure**<br/>a red stage only when failOnNonZeroExit"]
  class ok ok
  class red danger
```

The key is what makes that true. Until the runtime routed by the handle, a
second `acquire` returned the execution's one container and the stages raced to
wipe each other's checkout (`git clone` clears its target directory first): five
stages, five `CheckoutFailed`s, in under five seconds. Each keyed container is
destroyed as its stage finishes rather than idling out `sleepAfter` — the
dispatcher's end-of-run teardown owns the execution's own id and cannot know
what a run named.

**Not available on the substrate backend**, which namespaces one sandbox per
consumer execution. `acquire({ key })` there fails `ContainerLaunchFailed`
rather than quietly handing back the first container, because quietly handing it
back is the defect this option exists to fix.

The reason is the retry, not the speed. A stage step carries `retries: 3` on
`ExecFailed`, and with a shared container that guarantee is empty: container
disk is ephemeral, so when an instance dies the next one starts with no
checkout, and the retry re-runs the command against a directory that no longer
exists — failing in seconds for a reason unrelated to the original, which is
what the run then reports. Isolated, the retryable step is
`workspace` + `exec` as one unit, so a retry re-acquires, re-clones and
re-installs before running the command. A retry whose precondition the failure
destroyed is not a retry.

Two semantics follow from independence rather than from choice:

- **Every stage runs.** Sequential mode stops at the first red because later
  stages share its container and are treated as dependents; isolated stages have
  no such relationship, and stopping would discard results already paid for. All
  of them report, and the run fails if any failed. No `⊘ skipped` line can
  appear.
- **Each stage pays its own checkout and `install`.** On a repo whose install is
  a large cold download that is N times the bytes — overlapping in time, so it
  costs bandwidth rather than wall clock.

Use it when the stages are independent (different feature unifications of one
tree, say). Leave it at 1 when a later stage consumes an earlier one's output,
which sharing a container is the only way to express. A value above the stage
count is clamped to it.

## `worker-deploy` — continuous deploy on default-branch push

Webhook mode fires on `check_suite.requested` for the default branch, resolves
everything a push payload cannot carry from CONFIG_KV, and posts
`flare-dispatch/worker-deploy`. No command key → the run no-ops green.

```bash
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.command:owner/repo"    "pnpm build && pnpm exec wrangler deploy"
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.secrets:owner/repo"    "CLOUDFLARE_API_TOKEN"   # Worker-secret NAMES
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.timeoutSec:owner/repo" "1500"                   # positive integer
```

`timeoutSec` precedence is dispatch value → `worker-deploy.timeoutSec:<repo>` → 900. A malformed value degrades to 900.

**A deploy is never step-retried.** The `exec` step runs with `retries: 0` and a
Workflow step timeout of the exec timeout + 120s, so the sandbox's deadline —
not the platform's 600s step default — ends a slow deploy, and a failure is
reported once instead of re-publishing every Worker on a second attempt.

```mermaid
flowchart TB
  accTitle: worker-deploy steps and verdicts
  resolve["**resolve-config**<br/>command, timeout, secret names"] --> cmd{"command<br/>configured?"}
  cmd -->|no| noop["**success**<br/>not-configured, no deploy"]
  cmd -->|yes| head["**branch-head**<br/>read through the GitHub App"]
  head --> is{"head is<br/>the dispatched sha?"}
  is -->|"no, requireHead"| skip["**neutral**<br/>superseded by the head"]
  is -->|"yes, or unknown"| checkout["**checkout**<br/>clone the sha"]
  checkout --> exec["**exec**<br/>secrets loaded inline<br/>retries 0, step timeout +120s"]
  exec --> upload["**upload-log**<br/>step.log"]
  upload --> code{"exit code"}
  code -->|0| ok["**success**<br/>deployed"]
  code -->|"non-zero, failOnNonZeroExit"| red["**failure**<br/>not deployed"]
  class noop,ok ok
  class skip muted
  class red danger
```

### A second deploy of the same commit (`checkLabel`)

A repo that deploys part of its stack after other CI work — container-backed
Workers after an image build, say — dispatches `worker-deploy` a second time in
Action mode with a `checkLabel`. It posts `flare-dispatch/worker-deploy:<label>`
beside the webhook's check instead of overwriting it, and runs as its own
execution (the label is part of both the Action's `Idempotency-Key` and the
direct-dispatch instance id).

A labelled dispatch without `command` reads only
`worker-deploy.command:<repo>:<label>` — never the unlabelled key, which would
re-run the webhook's deploy. `worker-deploy.timeoutSec:<repo>:<label>` falls
back to the repo key.

```yaml
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: worker-deploy
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      {
        "repo": "${{ github.repository }}",
        "sha": "${{ github.sha }}",
        "branch": "${{ github.ref_name }}",
        "checkLabel": "containers",
        "failOnNonZeroExit": true
      }
```

A webhook dispatch and an Action dispatch of one push are always two executions:
the webhook's instance id is `worker-deploy_<repo_>_<sha12>`, the Action's is
`worker-deploy[-<label>]-<repo_>-<sha12>`.

### Deploy ordering

Deploys of one repo, branch, and `checkLabel` never overlap. While one runs, a
newer dispatch of the same group waits, and each new arrival replaces the
waiter before it: of three pushes in quick succession, the first deploys, the
second concludes `neutral` with `skipped: superseded by <third sha12>`, and the
third deploys after the first finishes. A running deploy is never cancelled. A
waiter that stays queued for 60 minutes behind a live deploy fails red
(`SerialQueueTimedOut`) without having started. A different branch or label is
a different group and runs alongside.

```mermaid
sequenceDiagram
  accTitle: Three pushes and a late dispatch in one deploy group
  participant A as Push A
  participant B as Push B
  participant C as Push C
  participant Q as Serial queue (D1)
  participant L as Late, old sha
  A->>Q: head is A — enqueue, claim
  Note over A: holds the group, deploys A
  B->>Q: head is B — enqueue
  Q-->>B: wait behind A
  C->>Q: head is C — enqueue
  Q-->>B: superseded by C
  Note over B: concludes neutral
  Note over L: head is C, not this sha —<br/>neutral, never enqueued
  A->>Q: release
  C->>Q: claim
  Note over C: branch-head matches — deploys C
```

Once a deploy holds its group and a sandbox slot, the dispatcher reads the
branch's head through the GitHub App. When the head is no longer the dispatched
`sha`, a newer push landed, and the deploy concludes `neutral` with
`skipped: superseded by <head sha12>` before cloning. A rollback that deploys an
older commit on purpose dispatches with `"requireHead": false`.

The command also receives that head, since it cannot look it up itself: the
checkout's `origin` carries no credential, so `git ls-remote` fails on a private
repo.

| Env                             | Value                                |
| ------------------------------- | ------------------------------------ |
| `FLAREDISPATCH_BRANCH`          | the dispatched `branch`, or empty    |
| `FLAREDISPATCH_BRANCH_HEAD_SHA` | the branch head at dequeue, or empty |
| `FLAREDISPATCH_SHA`             | the commit being deployed            |

**Empty means unknown, never a match.** The head is empty when the dispatch
names no `branch` (webhook mode always names it; an Action dispatch must pass
`"branch": "${{ github.ref_name }}"`), when the App has no credentials, and when
the read fails. A command that guards on the head picks one of two policies:

```bash
# Fail closed on unknown — no deploy without a confirmed head.
[ -n "$FLAREDISPATCH_BRANCH_HEAD_SHA" ] || { echo "branch head unknown"; exit 1; }
[ "$FLAREDISPATCH_BRANCH_HEAD_SHA" = "$FLAREDISPATCH_SHA" ] || exit 0

# Fail closed only on a mismatch — deploy when the head is unknown.
[ -z "$FLAREDISPATCH_BRANCH_HEAD_SHA" ] ||
  [ "$FLAREDISPATCH_BRANCH_HEAD_SHA" = "$FLAREDISPATCH_SHA" ] || exit 0
```

A known mismatching head never reaches the command — the dispatcher skipped it —
and a push that lands mid-deploy queues behind this one rather than racing it.
The guard's job is deciding what an unknown head means.

Before a dispatch joins the queue, it reads the branch head the same way. A
commit that is already not the head — a re-requested check suite of an old
commit, a late webhook — concludes `neutral` at once and never enters the queue,
so it cannot displace the head's waiting deploy. A dispatch that is the head
supersedes every waiter that is not, whatever order they arrived in. Only when
the head is unknown does arrival order decide which waiter survives.
