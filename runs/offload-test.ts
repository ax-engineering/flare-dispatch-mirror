// `offload-test` — the FlareDispatch V0 walking-skeleton run.
//
// Clones a repo, runs a single command in a Sandbox container, uploads the
// command's log to R2, and returns the exit code + duration + log URL. This is
// the run the V0 acceptance criterion exercises: a `pnpm test` executing in CF
// Sandbox reporting green/red back to a PR check.
//
// Contract — inputs/outputs per specs/02-runs.md § 1. Body shape per
// specs/03-dsl.md § Top-level shape: `checkout → exec → upload-log`.
//
// --- Pure webhook mode (specs/04-gha-integration.md § Pure webhook mode) ------
//
// `offload-test` is also the *test* run for the zero-GHA path: its
// `pull_request` trigger fires the repo's suite on every PR with no
// `.github/workflows/` file and no GHA minutes, posting a green/red
// `flare-dispatch/offload-test` check that branch protection requires. Two
// generalizations make that work without disturbing the Action-mode contract:
//
//   * `command` is OPTIONAL. The trigger's `inputs` is a sync, payload-only
//     callback — it cannot read CONFIG_KV — so a webhook dispatch omits the
//     command and the run body resolves it from `offload-test.command:<repo>`
//     (per-repo) falling back to `offload-test.command` (dispatcher-wide). An
//     Action dispatch still passes `command` and skips the lookup entirely.
//   * `failOnNonZeroExit` flips a non-zero exit into a red check. In Action mode
//     the GHA step reads `exitCode`, so it stays false (a failing test is a
//     normal result — see note 2). Webhook mode has no GHA step to read it: the
//     check-run is the only signal, so the trigger sets it true and a non-zero
//     exit fails the Effect with `AcceptanceFailed`.
//
// --- Staged mode (`offload-test.stages:<repo>`) -------------------------------
//
// One 40–60-minute buffered exec is a single point of failure: when the
// platform kills the step (observed `WorkflowInternalError` at 8 min,
// `ExecTimeout` at 30 min), the buffered log dies with it and the check-run
// links a 404 artifact — the operator cannot tell a capacity failure from a
// broken build (issue #39). Setting `offload-test.stages:<repo>` to a
// comma-separated list of labels (e.g. "workspace,features,connectors,ts")
// splits the run into one exec step per stage:
//
//   * each stage runs `exec-<label>` with its own command
//     (`offload-test.command:<repo>:<label>`, falling back to the unlabelled
//     command — the labelled-rung ladder `check` v1.1.0 introduced) and its own
//     timeout (`offload-test.timeoutSec:<repo>:<label>` ?? the dispatch
//     `timeoutSec` ?? the unlabelled rung ?? default), step timeout derived
//     with the same headroom and the same platform-retry policy;
//   * each stage's log uploads as `step-<label>.log` IMMEDIATELY after the
//     stage, so a later stage dying cannot take an earlier stage's log with it;
//   * a stage that exits non-zero stops the sequence (later stages are
//     `set -e`-style dependents of earlier ones); a stage step that DIES
//     (timeout/internal/platform kill) gets a one-line marker uploaded under
//     its `step-<label>.log` name and the run fails naming the stage, the
//     ✓/✗/⊘ rundown riding `StepFailed.summaryMd` so the check-run renders
//     it as real markdown. The marker rides the marker exec's own R2 log
//     stream (see the upload step), so it lands on both sandbox backends.
//
// Staging makes earlier stages' logs DURABLE — it does not buy a long suite
// more wall time. Each stage runs under its own exec ceiling (the labelled /
// unlabelled `timeoutSec` rungs), and every stage, with its retries, draws on
// the one run ceiling: the dispatcher fails the run `RunDurationExceeded` once
// `limits.maxDurationSec` elapses from the body's start. Size the stage
// ceilings to the suite and their sum to the run ceiling.
//
// --- Isolated stages (`offload-test.stageConcurrency:<repo>` > 1) -------------
//
// Staged mode above still shares ONE container across every stage, and that is
// what makes its retry policy a lie. A stage step carries `retries: 3` on
// `ExecFailed`, but a container's disk is EPHEMERAL — when the instance dies,
// the next one starts with a fresh disk and no checkout. So the retry re-execs
// `<command>` in a directory that no longer exists, fails in seconds for a
// reason unrelated to the original, and the run reports THAT. A retry whose
// precondition the failure destroyed is not a retry.
//
// Setting `offload-test.stageConcurrency:<repo>` above 1 makes each stage
// acquire its own workspace INSIDE its retryable step — `workspace` + `exec` as
// one unit — so a retry re-acquires a container, re-clones, and re-installs
// before running the command. That is the property; concurrency is what it
// costs nothing extra to add once stages no longer share a container.
//
// Two semantics change with it, both consequences of independence rather than
// choices:
//
//   * EVERY stage runs. Sequential mode stops at the first red because later
//     stages share its container and are treated as dependents. Isolated stages
//     have no such relationship, and stopping would throw away results already
//     paid for — so all of them report, and the run fails if any failed.
//   * Each stage pays its own checkout and `install`. On a repo whose install
//     is a large cold download that is N times the bytes; they overlap in time,
//     so it costs bandwidth rather than wall clock.
//
// Use it when the stages are independent — different feature unifications of
// the same tree, say. Leave it at 1 when a later stage genuinely consumes an
// earlier one's output, which sharing a container is the only way to express.
//
// Why sequential stages in ONE instance, not `matrix-fanout` + labelled
// `check` (separate instances, independent timeouts, parallel)? The stages
// are ordered dependents sharing one checkout — later stages assume earlier
// ones passed — and the repo gates on ONE `flare-dispatch/offload-test`
// check-run. Fanout buys parallelism an ordered suite cannot use, at the cost
// of N checkouts and N check-runs to re-aggregate.
//
// The key is resolved inside the same `resolve-command` step that reads the
// command, so staged mode exists only on the webhook path (a dispatch that
// passes `command` skips the step, exactly as before). ABSENT key → byte-
// identical behaviour to 1.1.0: one exec, one `step.log`, same step names.
// Instance id / dedup are UNCHANGED — stages are internal steps of one
// workflow instance posting one check-run. The dispatcher stays generic:
// stages are just labelled commands from KV, no repo-specific knowledge here.
//
// --- Three design decisions, documented inline -------------------------------
//
// 1. No `finalize` step in the run body.
//    specs/02-runs.md § 1 lists the steps as `checkout → exec → upload-log →
//    finalize`, but `finalize` is *not* a run-body concern: it is the D1
//    `executions`-row status write and the GitHub check-run callback, both of
//    which are runtime/Workflow plumbing, not run logic. The `RunWorkflow`
//    class (PR4) owns that boundary — it maps the run's terminal Exit to the
//    `executions` status + the check-run conclusion *after* the run Effect
//    returns. Keeping `finalize` out of the run body keeps the run pure,
//    portable, and testable against `CFRuntimeTest` with no Checks/Executions
//    assertions. The run-body steps are therefore exactly the three from
//    specs/03-dsl.md § Top-level shape.
//
// 2. `durationMs` comes from the `exec` step's `ExecResult` — `result.durationMs`.
//    This is what specs/03-dsl.md § Top-level shape sketches, and it is the
//    replay-safe source: only `step(...)` results are checkpointed/memoized by
//    the CF Workflow, so on replay `result` is restored from the checkpoint
//    identically. Anything read *outside* a step (e.g. an `io.now` in the run
//    body) re-executes on every replay and would yield a fresh value — not
//    replay-deterministic. Sourcing `durationMs` from the checkpointed exec
//    result keeps the run's output stable across replays. No `Date.now()` /
//    `crypto.randomUUID()` is called in the run body.
//
// 3. Credentials come from the config store via `loadSecrets`, never the
//    dispatch body. The `env` input is for non-sensitive values only: dispatch
//    inputs are persisted (the `executions` row, Workflow params), so a secret
//    riding `env` would sit in storage at rest. A command that needs
//    credentials names config-store keys in `secrets` (+ `secretPrefix`) and
//    the run resolves them with `loadSecrets({ required: true })` — same
//    contract as `cdp-acceptance` (see its header note 1). `loadSecrets` is
//    called INLINE, not in a `step(...)`: step results are checkpointed to
//    durable Workflow storage, and plaintext credentials must not land there
//    either. The config read is cheap + idempotent to re-run on replay.
//
//    Webhook mode cannot name secrets in the dispatch (the trigger's `inputs`
//    is sync + payload-only and pins `secrets: []`), so the NAMES resolve from
//    CONFIG_KV inside `resolve-command`, same contract as `worker-deploy`:
//    `offload-test.secrets:<repo>` (comma-separated env var names) and
//    `offload-test.secret-prefix:<repo>`. Dispatch-supplied `secrets` /
//    `secretPrefix` win; the keys are per-repo only — no dispatcher-wide
//    fallback, so one repo's credentials never reach another repo's command.
//    Only the names are checkpointed; VALUES come from Worker secrets
//    (`wrangler secret put <NAME>` on the dispatcher), never CONFIG_KV.
//    Absent key → the step returns exactly what it did before, and the run
//    loads no secrets.
//
//    Secrets load BEFORE `checkout`, because the dependency install runs
//    there: a repo whose `.npmrc` reads a registry token needs it at
//    `pnpm install` time, not only when the test command runs. The install
//    exec receives the secret env (and scrubs it from its log); every exec
//    path — single exec, sequential stages, isolated stages — receives the
//    secret env merged under the dispatch `env`.
//
// Spec: specs/02-runs.md § 1, specs/03-dsl.md § Top-level shape + § sandbox,
//       specs/pm/plan.md § PR3.

import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  commandFailureToIncident,
  config,
  defineRun,
  io,
  RunSkipped,
  sandbox,
  spawnChildRun,
  StepFailed,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  loadSecrets,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — specs/02-runs.md § 1. */
const OffloadTestInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * The command to run, e.g. `pnpm test` / `cargo test --workspace`. OPTIONAL:
   * a webhook-mode dispatch omits it (the `pull_request` trigger can't read
   * config) and the run body resolves it from CONFIG_KV — see `COMMAND_KEY`.
   */
  command: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String), // override container image
  /**
   * Run the R2-cached dependency install (`installCached`: lockfile-detected
   * tool, content-addressed restore) after the clone, so the command doesn't
   * have to open with its own cold `pnpm install` / `npm ci` / `cargo fetch`.
   *
   * Plain `optional`, NOT
   * `optionalWith({default: false})`: a schema default is applied at decode, so
   * the body could never tell "caller explicitly chose false" from "caller said
   * nothing" — and that distinction is what lets a webhook dispatch fall through
   * to `offload-test.install:<repo>`. The false default now lives in the body's
   * resolution chain instead, so the effective behaviour is unchanged for every
   * caller that passes a value.
   */
  install: Schema.optional(Schema.Boolean),
  /** Non-sensitive env only — dispatch inputs are persisted (header note 3). */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Config-store keys whose values are injected — as env vars of the same
   * name — into the command's env. Empty when the command needs no
   * credentials. See `loadSecrets` + header note 3.
   *
   * @deprecated ADR-0006 — a value in the command's env is a long-lived
   * credential reachable from inside the container, and redaction only keeps it
   * out of the log. Migrate to worker-side writeback or to a grant profile whose
   * credential the substrate's egress handler attaches
   * (apps/substrate/specs/credential-boundary.md); removed at stage-2 exit.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /**
   * Prefix prepended to each `secrets` key for the config lookup.
   *
   * @deprecated Ignored by `loadSecrets` (Worker bindings are bare names), and
   * removed with `secrets` at the substrate stage-2 exit (ADR-0006).
   */
  secretPrefix: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number), // default 600
  /**
   * Fail the run Effect (→ red `flare-dispatch/offload-test` check-run) when the
   * command exits non-zero. Default false preserves the V0 Action-mode contract:
   * a failing test is a normal `ExecResult` surfaced as `exitCode`, and the GHA
   * step reads it (see header note 2). Webhook mode has no GHA step, so its
   * `pull_request` trigger sets this true — the check-run is the only pass/fail
   * signal, so a non-zero exit must turn it red.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
});

/** Output contract — specs/02-runs.md § 1. */
const OffloadTestOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the step log
});

/** Default `exec` timeout when the caller omits `timeoutSec`. */
const TIMEOUT_SEC_DEFAULT = 600;

/**
 * Headroom added to the `exec` timeout to derive the Workflow STEP timeout, so
 * the sandbox's own deadline fires first (a clean `ExecTimeout` with the log
 * streamed so far) instead of the platform hard-killing the step at the same
 * instant (`WorkflowTimeoutError`, no log, nothing for `upload-log` to serve).
 * Same idea as playwright-demo's headroom, with one deliberate difference: NOT
 * clamped to `maxDurationSec`. At an exec timeout equal to the run ceiling the
 * clamp would collapse the headroom to zero — step and exec expire together
 * and the platform kill wins, which is exactly the failure this exists to
 * prevent. The run ceiling bounds the body as a whole, never one step.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

const PLATFORM_RETRIES = 3;

/**
 * The classes a stage step retries — never a verdict.
 *
 * `ExecFailed` is the obvious one: the command could not run. `StepFailed` is
 * the one that was missing, and its absence made the whole retry policy inert
 * on the failure it was written for.
 *
 * A command that RUNS and exits non-zero comes back as a normal `ExecResult`,
 * so no tag listed here can carry one. When the platform kills the step
 * outright, no Effect
 * `Cause` survives the Workflow boundary, `errorTagOf` falls back to
 * `"StepFailed"`, and a `retryOn` listing only `ExecFailed` classified that as
 * non-retryable — so the one failure mode that is purely the platform's was the
 * one the platform was never asked to retry.
 *
 * Observed: a 70-second TypeScript stage died as `StepFailed` after ~80s with
 * `check` and `oxlint` green beside it, and no retry was attempted. The same
 * consumer's heaviest stage peaks at 2.2 GiB of 11.9 GiB with 8.4 GB of disk
 * free, so this is not resource pressure being papered over.
 *
 * `CheckoutFailed` is the third because `ensureWorkspace` now re-clones INSIDE
 * this step. The clone runs in exactly the weather that made the rebuild
 * necessary — a container the platform just replaced — so its own transient
 * failure would otherwise end the step non-retryably, one call short of the
 * recovery it was invoked to perform.
 *
 * `CheckoutFailed` is a catch-all over the whole clone body, so deterministic
 * failures ride it too — a bad sha, a repo that is gone, and on the substrate
 * backend the recipe-pin mismatch. On the isolated path a stage's clone is the
 * run's FIRST, with no earlier `checkout` to have caught those, so this
 * knowingly spends the retry budget on some failures that cannot succeed: four
 * clone attempts plus backoff, times the stages running at once, each minting
 * its own installation token on the container backend. The alternative loses
 * the repair on every path, so it is the worse trade.
 *
 * `ExecTimeout` stays OUT, deliberately. Its tag survives the boundary intact
 * whenever there is a Cause to read, so it lands here as itself rather than as
 * `StepFailed` — and a command that outran its ceiling will outrun it again.
 */
const RETRY_ON = ["ExecFailed", "StepFailed", "CheckoutFailed"] as const;

const stepTimeoutFor = (execTimeoutSec: number): number =>
  execTimeoutSec + STEP_TIMEOUT_HEADROOM_SEC;

/**
 * CONFIG_KV keys the run body resolves the command from when a dispatch carries
 * no `command` (webhook mode — the `pull_request` trigger's `inputs` is a sync,
 * payload-only callback that can't read config). The per-repo key wins over the
 * dispatcher-wide default, so one dispatcher serves repos with different test
 * commands: `wrangler kv key put --binding=CONFIG_KV "offload-test.command:owner/repo" "cargo test --workspace"`.
 */
const COMMAND_KEY = "offload-test.command";
const repoCommandKey = (repo: string): string => `offload-test.command:${repo}`;

/**
 * Per-repo CONFIG_KV overrides for the two knobs a webhook dispatch cannot
 * supply. Same reason `command` needs a key: a trigger's `inputs` is a sync,
 * payload-only callback, so anything it cannot compute from the PR payload has
 * to be resolvable in the run body.
 *
 * Without these, webhook mode is pinned to `install: false` and a 600s timeout,
 * which is fine for a source-only command and unusable for the case this run
 * exists to serve — running a repo's actual test suite, which needs its
 * dependency tree and routinely outruns ten minutes. The two are a pair: a
 * suite that needs an install almost always needs the longer ceiling too.
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.install:owner/repo" "true"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.timeoutSec:owner/repo" "1800"
 *
 * An explicit dispatch value always wins; these only fill the gap the trigger
 * leaves. `timeoutSec` is enforced per exec by the sandbox's own deadline, and
 * the run's `limits.maxDurationSec` bounds the whole body above it: the exec,
 * its retries and every other step share that one ceiling.
 */
const repoInstallKey = (repo: string): string => `offload-test.install:${repo}`;
const repoTimeoutKey = (repo: string): string => `offload-test.timeoutSec:${repo}`;

/**
 * Staged-mode CONFIG_KV rungs (see header § Staged mode). The stages key holds
 * a comma-separated list of labels; each label may carry its own command and
 * timeout under the labelled rung, most specific first — same ladder shape as
 * `check.command:<repo>:<label>`:
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.stages:owner/repo" "workspace,features,ts"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.command:owner/repo:features" "pnpm test --filter features"
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.timeoutSec:owner/repo:ts" "900"
 */
const repoStagesKey = (repo: string): string => `offload-test.stages:${repo}`;
const stageCommandKey = (repo: string, label: string): string => `${repoCommandKey(repo)}:${label}`;
const stageTimeoutKey = (repo: string, label: string): string => `${repoTimeoutKey(repo)}:${label}`;

/**
 * How many stages run at once, and — inseparably — whether each gets its own
 * container:
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.stageConcurrency:owner/repo" "4"
 *
 * Absent or `1` is the shared-container sequential mode described above, byte
 * for byte. Above 1, every stage acquires its OWN workspace and up to N run
 * concurrently — see header § Isolated stages for why the two are one knob.
 */
const repoStageConcurrencyKey = (repo: string): string => `offload-test.stageConcurrency:${repo}`;

/**
 * Per-repo secret NAMES for webhook mode (header note 3). Values are Worker
 * secrets, never KV:
 *
 *   wrangler kv key put --binding=CONFIG_KV "offload-test.secrets:owner/repo" "NODE_AUTH_TOKEN"
 *   wrangler secret put NODE_AUTH_TOKEN
 *
 * Deliberately no unscoped `offload-test.secrets` fallback: a dispatcher-wide
 * list would inject one repo's credentials into every installed repo's tests.
 */
const repoSecretsKey = (repo: string): string => `offload-test.secrets:${repo}`;
const repoSecretPrefixKey = (repo: string): string => `offload-test.secret-prefix:${repo}`;

/** Comma-separated names → trimmed, non-empty list. */
const parseNameList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Legal stage label — same charset `check` enforces on `checkLabel`, for the
 * same reason: the label becomes a step name (`exec-<label>`) and a CONFIG_KV
 * key segment, so a stray `:`/space/emoji would produce keys and step names
 * that silently match nothing an operator typed. A malformed label fails the
 * resolve step loudly rather than degrading to a single exec — a typo'd stages
 * key that silently un-stages the run would resurrect exactly the
 * log-dies-with-the-step failure staging exists to fix.
 */
/**
 * Inner error classes worth recovering from a boundary-wrapped StepFailed's
 * rendered cause (see the errorClass recovery in staged mode). The typed tag
 * usually survives the step boundary intact; this covers the case where the
 * boundary eats it, where the class is usually still recoverable from the
 * rendered cause text (staging evidence: the same death read
 * `error=StepFailed` before this recovery, `error=ExecFailed` with it).
 * Anchored to the known tag vocabulary so vendor free text can never mint a
 * class — a pure platform error (`WorkflowInternalError`) contains none of
 * these words and falls back to `StepFailed`, the honest answer there.
 */
const INNER_EXEC_ERROR_RE = /\b(ExecTimeout|ExecFailed|CheckoutFailed)\b/;

const STAGE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** One resolved stage — plain JSON, because it rides the checkpointed resolve-step result. */
type ResolvedStage = {
  readonly label: string;
  readonly command: string;
  /** labelled `offload-test.timeoutSec:<repo>:<label>` — absent falls through to the unlabelled chain. */
  readonly timeoutSec?: number | undefined;
  /**
   * True when the labelled command rung was missing and the stage fell back
   * to the unlabelled command. Suspicious when stages are declared (usually a
   * typo'd key), so it is warned at resolve and recorded on the stage's
   * exec-step metadata. Two stages MAY share a command (a repo staging one
   * command purely for the per-stage timeout and log split): the facade keys
   * an exec's identity on the enclosing STEP as well as the command (#86), so
   * `exec-a` and `exec-b` stay distinct executions on both backends.
   */
  readonly commandFellBack: boolean;
};

/** `"true"`/`"1"` → true, `"false"`/`"0"` → false, anything else → undefined. */
const parseBoolConfig = (raw: string | undefined): boolean | undefined => {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
};

/**
 * A positive integer, or `undefined` for absent/garbage. Deliberately does NOT
 * fall back to the default on a malformed value's behalf — the caller does that,
 * so a typo'd key degrades to the documented default rather than to `NaN`, which
 * would reach `sandbox.exec` as a timeout that never fires.
 */
const parseIntConfig = (raw: string | undefined): number | undefined => {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const offloadTest = defineRun({
  name: "offload-test",
  // 1.4.0 — additive: per-repo secret names (`offload-test.secrets:<repo>`)
  // for webhook mode. Absent key → the 1.3.0 behaviour, byte-identical.
  // 1.3.0 — additive: isolated stages (`offload-test.stageConcurrency:<repo>`).
  // Absent or 1 → the 1.2.0 staged behaviour, byte-identical; no stages key →
  // the 1.1.0 single-exec behaviour, likewise.
  version: "1.4.0",

  // Webhook-mode trigger — the zero-GHA test path (specs/04-gha-integration.md
  // § Pure webhook mode). Fires the repo's suite on every PR push; the run body
  // resolves the command from CONFIG_KV (`command` is omitted here because this
  // callback is sync + payload-only). `failOnNonZeroExit: true` because the
  // check-run is the ONLY pass/fail signal in this mode.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      // Mirror Action mode's semantic instanceId (`{run}:{repo_}:{sha12}`) so a
      // webhook- and an Action-mode dispatch of the same commit collapse to one
      // execution at `create({id})` — same convention as pr-review.
      idempotencyKey: ({ payload }) =>
        `offload-test:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.pull_request?.head?.sha ?? "").slice(0, 12)}`,
      // Skip drafts (not ready to gate) and dependabot (shouldn't burn container
      // minutes) — mirrors pr-review's gate.
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      inputs: ({ payload }) => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // command / install / timeoutSec omitted — all three resolved from
        // CONFIG_KV in the run body. `install` in particular MUST stay omitted:
        // restating it here would look like an explicit caller choice and take
        // precedence over `offload-test.install:<repo>`, which is exactly the
        // override webhook mode has no other way to express.
        failOnNonZeroExit: true,
        // `secrets` keeps its schema default restated — a PR-triggered dispatch
        // must never carry credentials, so pinning it empty here is deliberate.
        // A repo whose command needs one names it in
        // `offload-test.secrets:<repo>`; the run body resolves it (note 3).
        secrets: [],
      }),
    },
  ],

  inputs: OffloadTestInput,
  outputs: OffloadTestOutput,

  limits: {
    // Run-body wall-time ceiling — specs/02-runs.md § 1, enforced by the
    // dispatcher. One documented 1800 s exec plus checkout, install and
    // upload fits; aligned retries of that exec do not (issue #42).
    maxDurationSec: 3600,
    // A PR verdict someone waits on: admitted ahead of batch work.
    admissionClass: "interactive",
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-command — webhook-mode dispatches omit `command`; resolve it
      // from CONFIG_KV (`offload-test.command:<repo>` then the dispatcher-wide
      // `offload-test.command`). This step runs ONLY when the dispatch carried
      // no command, so Action-mode dispatches keep the exact
      // `checkout → exec → upload-log` step shape (the `??` short-circuits before
      // the `yield*`). A command missing everywhere never runs — an empty
      // command would post a meaningless green check; the run skips instead
      // (neutral check, see below).
      // `install` / `timeoutSec` are resolved INSIDE this same step, not a
      // second one. They are a webhook-mode concern, and webhook mode is
      // exactly the case that omits `command` — so folding them in here means
      // an Action dispatch (which passes `command`) still skips the whole thing
      // and keeps the historical `checkout → exec → upload-log` step shape that
      // the suite pins. One step, one checkpoint, no new config reads for
      // callers that supply everything.
      const resolved: {
        command: string | undefined;
        install: boolean | undefined;
        timeoutSec: number | undefined;
        stages?: readonly ResolvedStage[] | undefined;
        stageConcurrency?: number | undefined;
        /** KV-resolved secret NAMES — never values (this is a step result). */
        secretNames?: readonly string[] | undefined;
        secretPrefix?: string | undefined;
      } =
        input.command === undefined
          ? yield* step("resolve-command", () =>
              Effect.gen(function* () {
                const perRepo = yield* config.get(repoCommandKey(input.repo));
                const command =
                  perRepo !== undefined && perRepo.trim().length > 0
                    ? perRepo
                    : yield* config.get(COMMAND_KEY);
                const install = parseBoolConfig(yield* config.get(repoInstallKey(input.repo)));
                const timeoutSec = parseIntConfig(yield* config.get(repoTimeoutKey(input.repo)));

                // secret NAMES — only when the dispatch named none. Added to
                // the step result only when the key yields names, so a repo
                // without the key checkpoints exactly what it did before.
                const secretNames =
                  input.secrets.length > 0
                    ? []
                    : parseNameList(yield* config.get(repoSecretsKey(input.repo)));
                const secretPrefix =
                  secretNames.length > 0 && input.secretPrefix === undefined
                    ? yield* config.get(repoSecretPrefixKey(input.repo))
                    : undefined;
                const secretFields = {
                  ...(secretNames.length > 0 ? { secretNames } : {}),
                  ...(secretPrefix !== undefined ? { secretPrefix } : {}),
                };

                // stages — resolved in this SAME step (not a new one) so the
                // unstaged step shape stays exactly what the suite pins, and so
                // staged mode exists only where the defect lives: the webhook
                // path, whose one buffered exec is the thing that dies. See
                // header § Staged mode.
                const stagesRaw = yield* config.get(repoStagesKey(input.repo));
                if (stagesRaw === undefined)
                  return { command, install, timeoutSec, ...secretFields };
                const labels = stagesRaw
                  .split(",")
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0);
                // A PRESENT key that yields no labels ("", " , ") is a typo'd
                // config, and silently un-staging the run would reproduce the
                // original defect (one buffered exec) while the operator
                // believes stages are on. Fail loudly, same as a bad label.
                if (labels.length === 0) {
                  return yield* Effect.fail(
                    new StepFailed({
                      step: "resolve-command",
                      cause:
                        `offload-test: \`${repoStagesKey(input.repo)}\` is set but ` +
                        `contains no labels — delete the key to disable staged mode`,
                    }),
                  );
                }

                // A malformed or duplicate label fails LOUDLY (see
                // STAGE_LABEL_RE's doc): a duplicate would mint two steps named
                // `exec-<label>` and two artifacts named `step-<label>.log`,
                // the second silently clobbering the first.
                const bad = labels.find((l) => !STAGE_LABEL_RE.test(l));
                if (bad !== undefined || new Set(labels).size !== labels.length) {
                  return yield* Effect.fail(
                    new StepFailed({
                      step: "resolve-command",
                      cause:
                        `offload-test: invalid \`${repoStagesKey(input.repo)}\` — ` +
                        (bad !== undefined
                          ? `label \`${bad}\` does not match ${String(STAGE_LABEL_RE)}`
                          : `duplicate label`),
                    }),
                  );
                }

                const stages: ResolvedStage[] = [];
                for (const label of labels) {
                  // Falling back to the unlabelled command is legal but
                  // suspicious when stages are declared (usually a typo'd key):
                  // warn here and record it on the exec-step metadata below.
                  const labelled = yield* config.get(stageCommandKey(input.repo, label));
                  const stageCommand =
                    labelled !== undefined && labelled.trim().length > 0 ? labelled : command;
                  const commandFellBack = stageCommand !== labelled;
                  if (commandFellBack) {
                    yield* io.log(
                      "warn",
                      `offload-test: stage \`${label}\` has no \`${stageCommandKey(input.repo, label)}\` — falling back to the unlabelled command`,
                    );
                  }
                  if (stageCommand === undefined || stageCommand.trim().length === 0) {
                    return yield* Effect.fail(
                      new StepFailed({
                        step: "resolve-command",
                        cause:
                          `offload-test: stage \`${label}\` has no command — set ` +
                          `CONFIG_KV \`${stageCommandKey(input.repo, label)}\` or the ` +
                          `unlabelled \`${repoCommandKey(input.repo)}\` fallback`,
                      }),
                    );
                  }
                  stages.push({
                    label,
                    command: stageCommand,
                    timeoutSec: parseIntConfig(
                      yield* config.get(stageTimeoutKey(input.repo, label)),
                    ),
                    commandFellBack,
                  });
                }
                // Read in the same step as the stages it governs — it is
                // meaningless without them, and a second config read on the
                // Action path (which never gets here) would be pure cost.
                const stageConcurrency = parseIntConfig(
                  yield* config.get(repoStageConcurrencyKey(input.repo)),
                );
                return {
                  command,
                  install,
                  timeoutSec,
                  stages,
                  stageConcurrency,
                  ...secretFields,
                };
              }),
            )
          : {
              command: input.command,
              install: undefined,
              timeoutSec: undefined,
            };
      const stages = resolved.stages;
      const command = resolved.command;
      // Unstaged only: with stages declared, every stage already carries a
      // resolved command (the step above fails otherwise), and the unlabelled
      // command may legitimately be absent.
      if (stages === undefined && (command === undefined || command.trim().length === 0)) {
        // A webhook dispatch reaches every repo the App is installed on, and a
        // repo that never set a command has not opted in — its tests may run
        // somewhere else entirely. That is a skip (neutral check naming the key
        // to set), not a failure: a red that no PR author can act on trains
        // people to ignore the check. An Action dispatch chose this run and
        // passed an empty command, which is a broken caller, so it stays red.
        if (input.command === undefined) {
          return yield* Effect.fail(
            new RunSkipped({
              reason:
                `no offload-test command is configured for ${input.repo} — set CONFIG_KV ` +
                `\`${repoCommandKey(input.repo)}\` or \`${COMMAND_KEY}\` to run it`,
            }),
          );
        }
        return yield* Effect.fail(
          new StepFailed({
            step: "resolve-command",
            cause:
              `offload-test: no command — pass \`command\` in the dispatch or set ` +
              `CONFIG_KV \`${repoCommandKey(input.repo)}\` or \`${COMMAND_KEY}\``,
          }),
        );
      }

      // Dispatch value → CONFIG_KV → documented default. The `false` here is the
      // schema default that used to live on the input (see its doc comment), so
      // a caller that passes nothing anywhere lands exactly where it always did.
      const install = input.install ?? resolved.install ?? false;
      const timeoutSec = input.timeoutSec ?? resolved.timeoutSec ?? TIMEOUT_SEC_DEFAULT;

      // How many stages run at once — and therefore whether they share a
      // container at all (header § Isolated stages). Clamped at the stage count
      // because asking for more concurrency than there is work is a config typo,
      // not a request for more containers.
      const stageConcurrency =
        stages === undefined
          ? 1
          : Math.min(Math.max(resolved.stageConcurrency ?? 1, 1), stages.length);
      const isolatedStages = stages !== undefined && stageConcurrency > 1;

      // load-secrets — resolve the named credentials from Worker secrets into
      // the env injected below. Called INLINE, not in a `step`: secrets must
      // not land in a durable Workflow checkpoint (see header note 3). Names
      // come from the dispatch, else from `offload-test.secrets:<repo>`
      // (resolved above). A no-op (empty record) when no names resolve. Runs
      // BEFORE `checkout` so the dependency install there can use them.
      const secretNames = input.secrets.length > 0 ? input.secrets : (resolved.secretNames ?? []);
      const secretEnv = yield* loadSecrets(secretNames, {
        prefix: input.secretPrefix ?? resolved.secretPrefix,
        required: true,
      });

      /**
       * The command, safe to RENDER.
       *
       * `redactValues` on the exec covers what the sandbox layer persists — the
       * R2 log and `ExecTimeout.message`. It does not reach the command string
       * this run then embeds itself, and those surfaces are the loud ones:
       * `summaryMd` is rendered as unfenced markdown straight into the GitHub
       * check-run summary, which on a public repo is public, and the self-heal
       * path carries the command into a child execution's `input_json`. A dying
       * stage also never reaches `ExecTimeout` — it is caught and replaced by
       * `deadFailure` — so the layer-level scrub does not apply there at all.
       *
       * Duplicated logic rather than a shared import: `redact` exists three
       * times already (sandbox-cf, sandbox-facade, sandbox-fake) and unifying
       * them is its own change. This is the narrow version, for one job.
       */
      //
      // The values scrubbed are BOTH the store value and the one the container
      // actually receives for each secret-designated key. Per-dispatch `env`
      // wins over a same-named store secret, so `Object.values(secretEnv)`
      // alone holds the shadowed value on a collision — the log would keep the
      // live credential and scrub a string that was never printed. The shadowed
      // store value stays in the list too: it is still a live credential, and
      // a command can inline it even while the env carries the override.
      // Non-secret `input.env` keys are deliberately NOT in this list: dispatch
      // inputs are documented non-sensitive (header note 3), and scrubbing a
      // value like "production" or "1" from every log line trades a contract
      // violation nobody has made for garbled logs everybody reads.
      const effectiveEnv: Record<string, string> = { ...secretEnv, ...input.env };
      const secretValues = [
        ...new Set(
          Object.keys(secretEnv).flatMap((key) => [secretEnv[key] ?? "", effectiveEnv[key] ?? ""]),
        ),
      ].filter((v) => v.length > 0);
      const renderable = (command: string): string =>
        secretValues.reduce((out, value) => out.split(value).join("***"), command);

      // The install inside `workspace` gets the secret keys too (a private
      // registry token is needed at install time), with the same values the
      // command sees — a dispatch `env` override wins there as well. Only the
      // secret keys: the install never took the non-secret dispatch `env`, and
      // still doesn't. Spread only when there is something to pass, so a run
      // without secrets issues the same install exec it always did.
      const installSecrets =
        secretValues.length > 0
          ? {
              installEnv: Object.fromEntries(
                Object.keys(secretEnv).map((key) => [key, effectiveEnv[key] ?? ""]),
              ),
              redactValues: secretValues,
            }
          : {};

      // checkout — acquire a container (honouring the `image` override), clone
      // the repo at the requested SHA, and optionally run the R2-cached
      // dependency install. One primitive, same opening move as cdp-acceptance.
      //
      // SKIPPED for isolated stages: each acquires its own workspace inside its
      // own retryable step, so a shared one here would be a container paid for
      // and never used.
      // `key` is what makes isolated stages actually isolated. Without it every
      // stage's `workspace()` resolved to the execution's single container and
      // they raced to wipe each other's checkout — `git clone` clears its target
      // directory first, so five stages produced five `CheckoutFailed`s in under
      // five seconds. Unkeyed (the shared-container mode) is unchanged.
      const acquireWorkspace = (key?: string) =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install,
          ...installSecrets,
          ...(key !== undefined ? { key } : {}),
        });
      const shared = isolatedStages ? undefined : yield* step("checkout", () => acquireWorkspace());

      // self-heal — (gated, OFF unless `self-heal.ci.enabled=true`) auto-dispatch
      // a fix for a DETERMINISTIC CI failure. Unlike the LLM-driven demo verdict
      // (which needs k-of-n confirmation), a non-zero exit IS ground truth — the
      // command is the deterministic oracle, so one failed command escalates
      // directly. One `ci`-class incident → one child `self-heal-pr`, deduped on
      // `{repo, sha}` so re-runs of the same commit collapse to a single heal (a
      // new push re-heals). Per-heal model spend is bounded by the AgentBudget DO.
      // Best-effort throughout — a dispatch fault never changes this run's check
      // outcome. Shared by the single-exec path and staged mode (where the
      // FAILING stage's command is the oracle); a DEAD stage never heals — there
      // is no ExecResult ground truth to hand the healer.
      // specs/08-self-healing.md § 4 (ci class) + § 9 (dedup).
      const maybeDispatchSelfHeal = (
        failedCommand: string,
        execResult: { readonly exitCode: number; readonly stdout: string },
        failLogUri: string,
      ) =>
        Effect.gen(function* () {
          if (execResult.exitCode === 0) return;
          if ((yield* config.get("self-heal.ci.enabled")) !== "true") return;
          // A command whose rendering CHANGED had a secret value inlined in it,
          // and neither version of it can honestly go to the healer. The raw
          // command would smuggle a live credential into the credential-free
          // agent sandbox and into a pack an injection-steerable LLM reads
          // (ci-incident.ts header); the scrubbed one carries `***` where the
          // verify step's re-run needs the value, so the heal can only fail
          // after the agent spend is already paid. Skip, and say why.
          if (renderable(failedCommand) !== failedCommand) {
            yield* io.log(
              "warn",
              `offload-test: skipping self-heal — the failing command inlines a secret value, so no honest repro can be handed to the healer`,
            );
            return;
          }
          const incident = commandFailureToIncident({
            repo: input.repo,
            sha: input.sha,
            command: failedCommand,
            exitCode: execResult.exitCode,
            logTail: execResult.stdout,
            logUri: failLogUri,
          });
          if (incident === null) return;
          yield* step("dispatch-self-heal", () =>
            spawnChildRun({
              run: "self-heal-pr",
              input: { incident },
              instanceId: `self-heal:${incident.incidentId}:${input.sha}`.slice(0, 200),
            }),
          ).pipe(
            Effect.flatMap((handle) =>
              io.log(
                "info",
                `offload-test: dispatched self-heal-pr ${handle.executionId} for ${input.repo}@${input.sha.slice(0, 12)}${handle.created ? "" : " (deduped — already dispatched)"}`,
              ),
            ),
            Effect.catchAllCause((cause) =>
              io.log(
                "warn",
                `offload-test: self-heal dispatch failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
              ),
            ),
          );
        });

      // --- Staged mode (semantics: header § Staged mode) ----------------------
      if (stages !== undefined) {
        // What one stage did, as data.
        //
        // The two drivers below produce exactly these and differ only in how
        // they schedule them and what they do with a failure — which is the
        // whole difference between "later stages are dependents" and "later
        // stages are peers". Keeping the per-stage work in one place is what
        // makes that difference a handful of lines rather than a second copy
        // of the exec/upload/marker sequence.
        type StageOutcome =
          | {
              readonly kind: "ok";
              readonly line: string;
              readonly durationMs: number;
              readonly logUri: string;
            }
          | {
              readonly kind: "red";
              readonly line: string;
              readonly stage: ResolvedStage;
              readonly exitCode: number;
              readonly stdout: string;
              readonly durationMs: number;
              readonly logUri: string;
            }
          | {
              readonly kind: "dead";
              readonly line: string;
              readonly stage: ResolvedStage;
              readonly errorClass: string;
              readonly elapsedS: number;
            }
          // The stage ran to a verdict and its LOG did not land. Its own kind
          // rather than a `dead`, because the two need different words: this
          // stage has an exit code and no artifact, and telling an operator it
          // "died" would send them looking for a marker that describes a death
          // that did not happen.
          | {
              readonly kind: "unreported";
              readonly line: string;
              readonly stage: ResolvedStage;
              readonly errorClass: string;
            };

        // Give a keyed container back as soon as its stage is finished.
        //
        // `acquire` derives an id and provisions nothing, so re-deriving it here
        // is free and replay-safe — no handle has to survive the step boundary.
        // Best-effort: a destroy that fails costs the `sleepAfter` window, and
        // must never become the stage's verdict.
        //
        // Isolated stages only. The shared container is the execution's own and
        // the dispatcher's end-of-run teardown owns it; destroying it here would
        // take the next stage's checkout with it.
        const reapStageContainer = (label: string) =>
          isolatedStages
            ? sandbox
                .acquire({ key: label })
                .pipe(
                  Effect.flatMap((container) => sandbox.destroy({ container })),
                  Effect.catchAllCause((cause) =>
                    io.log(
                      "warn",
                      `offload-test: could not destroy stage \`${label}\`'s container (sleepAfter reaps) — ${Cause.pretty(cause).slice(0, 200)}`,
                    ),
                  ),
                )
            : Effect.void;

        const runStage = (stage: ResolvedStage) =>
          Effect.gen(function* () {
            // Labelled rung ?? dispatch value ?? unlabelled rung ?? default. The
            // labelled rung outranks the dispatch value deliberately: staged mode
            // only exists when the dispatch omitted `command` (webhook mode), so
            // a `timeoutSec` riding such a dispatch is a coarse whole-run knob,
            // not a per-stage choice — the stage-specific key is more specific.
            const stageTimeoutSec =
              stage.timeoutSec ?? input.timeoutSec ?? resolved.timeoutSec ?? TIMEOUT_SEC_DEFAULT;

            // Inline (non-step) clock read — feeds ONLY the dead-stage marker +
            // summary below, never the run output, so replay re-reads are
            // harmless (header note 2 applies to output-bearing values).
            const stageStartMs = yield* io.now;

            // Same two-timeout derivation and retry policy as the single exec
            // below (see its comment): the exec's own deadline must fire before
            // the step's.
            const exit = yield* Effect.exit(
              step(
                `exec-${stage.label}`,
                () =>
                  // THE RETRYABLE UNIT, and the reason isolation exists. With a
                  // shared container it is the exec alone, which is only sound
                  // while that container survives. Isolated, it is
                  // acquire → clone → install → exec, so a platform retry
                  // rebuilds the workspace the death took with it rather than
                  // re-running the command against a disk that no longer holds
                  // a checkout (header § Isolated stages).
                  Effect.gen(function* () {
                    // Isolated: this stage's own workspace, built here so a
                    // retry rebuilds it. Shared: the run's workspace, CHECKED
                    // here for the same reason — see `ensureWorkspace`.
                    const ws =
                      shared === undefined
                        ? yield* acquireWorkspace(stage.label)
                        : yield* ensureWorkspace({
                            current: shared,
                            repo: input.repo,
                            sha: input.sha,
                            ...(input.image !== undefined ? { image: input.image } : {}),
                            install,
                            ...installSecrets,
                          });
                    return yield* sandbox.exec({
                      cwd: ws.dir,
                      container: ws.container,
                      command: stage.command,
                      env: { ...secretEnv, ...input.env },
                      // Defense in depth, as `check` and `worker-deploy` already
                      // do: this run executes the CONSUMER's own command, where
                      // `set -x` and a stray `env` are ordinary rather than
                      // exceptional, and the captured log is durable and signed.
                      redactValues: secretValues,
                      timeoutSec: stageTimeoutSec,
                    });
                  }),
                {
                  timeoutSec: stepTimeoutFor(stageTimeoutSec),
                  retries: PLATFORM_RETRIES,
                  retryOn: RETRY_ON,
                  // Surface the suspicious labelled-key-missing fallback (see
                  // ResolvedStage.commandFellBack) on the step record, where an
                  // operator reading the step table will actually see it.
                  ...(stage.commandFellBack
                    ? { metadata: { "offload-test.commandFallback": true } }
                    : {}),
                },
              ),
            );

            if (Exit.isFailure(exit)) {
              // The stage step DIED — ExecTimeout / ExecFailed / platform kill —
              // and its real log is unavailable. Upload a one-line marker under
              // the stage's own log name so the artifact endpoint never 404s
              // (issue #39's "marker artifact on timeout"). Marker is
              // BEST-EFFORT: the container may be as dead as the step, and a
              // marker fault must not mask the stage failure. Elapsed comes
              // from `io.now` — diagnostic only, never in the run OUTPUT, so
              // replay determinism is unaffected.
              const errorClass = Option.match(Cause.failureOption(exit.cause), {
                onSome: (f) => {
                  const tag = (f as { _tag?: unknown })._tag;
                  if (typeof tag !== "string") return "UnknownError";
                  if (tag !== "StepFailed") return tag;
                  // The typed tag usually survives the Workflow boundary (the
                  // CF step runner re-fails with the surviving Cause). When no
                  // Cause survives, the runner re-fails as a bare StepFailed
                  // (step-runner-cf) and the class is usually still recoverable
                  // from the rendered cause text — recover it there so the
                  // marker and rundown can say ExecTimeout vs ExecFailed. A
                  // pure platform error (WorkflowInternalError) carries no exec
                  // vocabulary to recover; it stays StepFailed, honestly.
                  const rendered = String((f as { cause?: unknown }).cause ?? "");
                  return INNER_EXEC_ERROR_RE.exec(rendered)?.[1] ?? tag;
                },
                onNone: () => "Defect",
              });
              const elapsedMs = (yield* io.now) - stageStartMs;
              const elapsedS = Math.round(elapsedMs / 1000);
              // Label (STAGE_LABEL_RE), tag, numbers, and — when the platform
              // supplied one — its own incident id.
              //
              // `ExecFailed: exec failed (exit -1): internal error; reference =
              // aggq3f5m407e2vb2ht76l2vf` is what a dying container reports, and
              // that reference is the only thing that identifies the incident to
              // the platform's operator. The marker used to record the CLASS and
              // drop the id, which is the half a consumer can already infer from
              // the fact that their stage died.
              //
              // EXTRACTED, not interpolated: the marker is shell-quoted into a
              // `printf '%s\n' '<line>'`, so free vendor text could close the
              // quote. A `[A-Za-z0-9_-]` id and a signed integer cannot.
              const rendered = Option.match(Cause.failureOption(exit.cause), {
                onSome: (f) =>
                  `${String((f as { cause?: unknown }).cause ?? "")} ${String((f as { message?: unknown }).message ?? "")}`,
                onNone: () => "",
              });
              const reference = /reference\s*=\s*([A-Za-z0-9_-]{1,64})/.exec(rendered)?.[1];
              const platformExit = /exit\s+(-?\d{1,5})\)/.exec(rendered)?.[1];
              const markerLine =
                `stage=${stage.label} error=${errorClass} elapsedMs=${elapsedMs}` +
                (platformExit !== undefined ? ` exit=${platformExit}` : "") +
                (reference !== undefined ? ` reference=${reference}` : "");
              // The marker rides the marker exec's OWN log stream: `sandbox.exec`
              // streams stdout to an R2 log key and returns it as `logPath`, so
              // uploading THAT key in R2-source mode (no `container` — same mode
              // as the green-stage upload above) works on both sandbox backends.
              // Container-mode upload (`artifact.upload({ container })`) throws
              // on the facade backend, where no Sandbox namespace is wired
              // (runtime-cf/artifact-r2.ts) — the marker never landed there.
              yield* step(
                `upload-log-${stage.label}`,
                () =>
                  Effect.gen(function* () {
                    // A dead ISOLATED stage leaves no container behind — its own
                    // was the thing that died and no other stage's is reachable
                    // from here. So the marker acquires one. That is a container
                    // spent on a failure path, which is exactly the path where
                    // `step-<label>.log` resolving instead of 404-ing is worth
                    // something.
                    const box =
                      shared === undefined
                        ? yield* sandbox.acquire({ image: input.image })
                        : shared.container;
                    const marker = yield* sandbox.exec({
                      container: box,
                      command: `printf '%s\\n' '${markerLine}'`,
                      timeoutSec: 30,
                    });
                    return yield* artifact.upload({
                      name: `step-${stage.label}.log`,
                      path: marker.logPath,
                      contentType: "text/plain",
                      signedUrlTTL: "30 days",
                    });
                  }),
                // Best-effort against a possibly-dead container: never inherit
                // the platform's default retries/timeout for work whose failure
                // is already tolerated by the catch below.
                { timeoutSec: 60, retries: 0 },
              ).pipe(
                Effect.catchAllCause((cause) =>
                  io.log(
                    "warn",
                    `offload-test: marker upload for dead stage \`${stage.label}\` failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                  ),
                ),
              );
              return {
                kind: "dead",
                stage,
                errorClass,
                elapsedS,
                line: `- ✗ \`${stage.label}\` — died (\`${errorClass}\`) after ~${elapsedS}s`,
              } as const;
            }

            const result = exit.value;
            // upload NOW, before the next stage runs — the whole point of staging.
            //
            // CAUGHT rather than propagated. Let it escape and, in isolated
            // mode, `Effect.forEach` interrupts every peer still running — so
            // one R2 hiccup would take down stages that had nothing to do with
            // it, and "every stage runs" would quietly stop being true. It
            // still fails the run; it just does so as this stage's own outcome,
            // after the peers have reported.
            const uploaded = yield* Effect.exit(
              step(`upload-log-${stage.label}`, () =>
                artifact.upload({
                  name: `step-${stage.label}.log`,
                  path: result.logPath,
                  signedUrlTTL: "30 days",
                }),
              ),
            );
            if (Exit.isFailure(uploaded)) {
              const errorClass = Option.match(Cause.failureOption(uploaded.cause), {
                onSome: (f) => {
                  const tag = (f as { _tag?: unknown })._tag;
                  return typeof tag === "string" ? tag : "UnknownError";
                },
                onNone: () => "Defect",
              });
              return {
                kind: "unreported",
                stage,
                errorClass,
                line: `- ✗ \`${stage.label}\` — exit \`${result.exitCode}\` in ${(result.durationMs / 1000).toFixed(1)}s, but its log did not upload (\`${errorClass}\`)`,
              } as const;
            }
            const logUri = uploaded.value;

            if (result.exitCode !== 0) {
              return {
                kind: "red",
                stage,
                exitCode: result.exitCode,
                stdout: result.stdout,
                durationMs: result.durationMs,
                logUri,
                line: `- ✗ \`${stage.label}\` — exit \`${result.exitCode}\` in ${(result.durationMs / 1000).toFixed(1)}s ([log ↗](${logUri}))`,
              } as const;
            }
            return {
              kind: "ok",
              durationMs: result.durationMs,
              logUri,
              line: `- ✓ \`${stage.label}\` — ${(result.durationMs / 1000).toFixed(1)}s ([log ↗](${logUri}))`,
            } as const;
          }).pipe(
            // On EVERY exit — each of the four outcomes, an interrupt when a
            // peer fails, a defect. Enumerating the return paths worked and was
            // the wrong shape: it is correct only for as long as nobody adds a
            // fifth outcome, and the cost of forgetting is a container idling
            // out `sleepAfter` on the bill. A finalizer cannot be forgotten.
            //
            // After the outcome, not before: everything the outcome carries is
            // already in R2 by then, so the container is genuinely finished
            // with.
            Effect.ensuring(reapStageContainer(stage.label)),
          );

        const deadFailure = (
          outcome: Extract<StageOutcome, { kind: "dead" }>,
          lines: readonly string[],
        ) =>
          // The rundown rides `summaryMd` — the run-authored-markdown channel
          // `AcceptanceFailed` already uses for the red-stage path — so the
          // check-run renders the ✓/✗/⊘ lines and log links as real markdown
          // instead of fencing them inside `stepFailedMd`'s code block.
          // `AcceptanceFailed` itself does not fit here: its required
          // `exitCode` means "the command ran to completion", and a dead stage
          // produced no exit code to report. `cause` stays a plain one-liner
          // for the Workflow error record.
          new StepFailed({
            step: `exec-${outcome.stage.label}`,
            cause: `stage \`${outcome.stage.label}\` (\`${renderable(outcome.stage.command)}\`) died: ${outcome.errorClass} after ~${outcome.elapsedS}s`,
            summaryMd: [
              `Stage \`${outcome.stage.label}\` — \`${renderable(outcome.stage.command)}\` — died (\`${outcome.errorClass}\`) after ~${outcome.elapsedS}s. ` +
                `Earlier stage logs are already uploaded; this stage's log is the marker artifact \`step-${outcome.stage.label}.log\`.`,
              "",
              ...lines,
            ].join("\n"),
          });

        const unreportedFailure = (
          outcome: Extract<StageOutcome, { kind: "unreported" }>,
          lines: readonly string[],
        ) =>
          new StepFailed({
            step: `upload-log-${outcome.stage.label}`,
            cause: `stage \`${outcome.stage.label}\` ran, but its log upload failed: ${outcome.errorClass}`,
            summaryMd: [
              `Stage \`${outcome.stage.label}\` — \`${renderable(outcome.stage.command)}\` — ran to a verdict, but \`step-${outcome.stage.label}.log\` did not upload (\`${outcome.errorClass}\`). ` +
                `The verdict is in the rundown below; the log is not retrievable.`,
              "",
              ...lines,
            ].join("\n"),
          });

        // --- Isolated stages: every stage runs, then the run reports -----------
        if (isolatedStages) {
          // No `⊘ skipped` line is possible here and none is wanted: nothing is
          // skipped, because nothing was waiting on anything.
          const outcomes = yield* Effect.forEach(stages, runStage, {
            concurrency: stageConcurrency,
          });
          const lines = outcomes.map((o) => o.line);
          // SUM, as in sequential mode — the same quantity, and deliberately
          // not the wall clock, which concurrency makes smaller than the work
          // performed. `logUri` is the last stage that produced one.
          const durationTotalMs = outcomes.reduce(
            (total, o) => (o.kind === "ok" || o.kind === "red" ? total + o.durationMs : total),
            0,
          );
          const logUri = outcomes.reduce(
            (last, o) => (o.kind === "ok" || o.kind === "red" ? o.logUri : last),
            "",
          );

          // Every red stage is its own deterministic oracle, so each escalates.
          // Dead stages do not: there is no ExecResult to hand the healer.
          for (const outcome of outcomes) {
            if (outcome.kind === "red") {
              yield* maybeDispatchSelfHeal(
                outcome.stage.command,
                { exitCode: outcome.exitCode, stdout: outcome.stdout },
                outcome.logUri,
              );
            }
          }

          const dead = outcomes.find((o) => o.kind === "dead");
          if (dead !== undefined) return yield* Effect.fail(deadFailure(dead, lines));

          // Ahead of the red check: a stage whose log did not upload has a
          // verdict nobody can read, and reporting the OTHER stage's exit code
          // as the run's would bury that.
          const unreported = outcomes.find((o) => o.kind === "unreported");
          if (unreported !== undefined)
            return yield* Effect.fail(unreportedFailure(unreported, lines));

          const red = outcomes.find((o) => o.kind === "red");
          if (red !== undefined) {
            if (input.failOnNonZeroExit) {
              return yield* Effect.fail(
                new AcceptanceFailed({
                  exitCode: red.exitCode,
                  summaryMd: [
                    `Stage \`${red.stage.label}\` — \`${red.stage.command}\` — exited \`${red.exitCode}\`. Every stage ran; they are independent.`,
                    "",
                    ...lines,
                  ].join("\n"),
                }),
              );
            }
            return { exitCode: red.exitCode, durationMs: durationTotalMs, logUri };
          }
          return { exitCode: 0, durationMs: durationTotalMs, logUri };
        }

        // --- Shared container, sequential: later stages are dependents --------
        // Summary ledger — every stage lands here as a ✓/✗/⊘ line, and the
        // failure summary carries the whole list so the check names the stage
        // without the operator opening a single log.
        const lines: string[] = [];
        const skippedLines = (from: number): string[] =>
          stages.slice(from).map((s) => `- ⊘ \`${s.label}\` — skipped`);
        let durationTotalMs = 0;
        let logUri = "";

        for (let i = 0; i < stages.length; i++) {
          const outcome = yield* runStage(stages[i]!);
          lines.push(outcome.line);

          if (outcome.kind === "dead") {
            lines.push(...skippedLines(i + 1));
            return yield* Effect.fail(deadFailure(outcome, lines));
          }

          if (outcome.kind === "unreported") {
            lines.push(...skippedLines(i + 1));
            return yield* Effect.fail(unreportedFailure(outcome, lines));
          }

          durationTotalMs += outcome.durationMs;
          logUri = outcome.logUri;

          if (outcome.kind === "red") {
            lines.push(...skippedLines(i + 1));
            yield* maybeDispatchSelfHeal(
              outcome.stage.command,
              { exitCode: outcome.exitCode, stdout: outcome.stdout },
              logUri,
            );
            if (input.failOnNonZeroExit) {
              return yield* Effect.fail(
                new AcceptanceFailed({
                  exitCode: outcome.exitCode,
                  summaryMd: [
                    `Stage \`${outcome.stage.label}\` — \`${renderable(outcome.stage.command)}\` — exited \`${outcome.exitCode}\`; later stages skipped.`,
                    "",
                    ...lines,
                  ].join("\n"),
                }),
              );
            }
            // failOnNonZeroExit off: `set -e` semantics — the failing stage's
            // exit code becomes the run's, later stages don't run (they are
            // dependents of the one that just went red).
            return { exitCode: outcome.exitCode, durationMs: durationTotalMs, logUri };
          }
        }

        // All stages green. Output mirrors the single-exec contract: exit 0,
        // the SUM of the checkpointed stage durations (replay-safe — each is a
        // memoized step result, header note 2), the LAST stage's log URL.
        return { exitCode: 0, durationMs: durationTotalMs, logUri };
      }

      // --- Single-exec path (unchanged 1.1.0 behaviour) ----------------------
      // TS cannot carry the pre-checkout no-command guard's narrowing across
      // the staged branch above — re-derive; the fail arm is unreachable.
      const soleCommand =
        command ??
        (yield* Effect.fail(
          new StepFailed({
            step: "resolve-command",
            cause: "unreachable: command presence checked before checkout",
          }),
        ));
      // Isolation only exists with stages, and stages never reach here — so a
      // single-exec run always took the shared checkout. Same shape as the
      // guard above: TS cannot see it, the fail arm is unreachable.
      const soleWorkspace =
        shared ??
        (yield* Effect.fail(
          new StepFailed({
            step: "checkout",
            cause: "unreachable: a single-exec run always takes the shared checkout",
          }),
        ));

      // exec — run the command. A non-zero exit code is a NORMAL ExecResult
      // (a failing test), surfaced to the output below — never an Effect
      // failure. `sandbox.exec` fails its Effect only with ExecFailed /
      // ExecTimeout, which propagate out of the run unchanged. `result` is the
      // checkpointed step output — replay restores it identically, which is
      // why the run's `durationMs` is read from it (see header note 2).
      // There are two timeouts and they are not the same one. `timeoutSec`
      // below bounds the command; the Workflow step wrapping it has its own,
      // defaulting to 600s. Leave the step's unset and the lower ceiling wins
      // silently: a repo configuring `offload-test.timeoutSec = 1800` gets
      // `WorkflowTimeoutError: Execution timed out after 600000ms` at ten
      // minutes, from a limit nothing in its config mentions, and the artifact
      // is empty because the step died rather than the command.
      //
      // So the step timeout is DERIVED from the exec timeout rather than
      // configured beside it — two knobs that must agree are one knob with a
      // bug in it — with `STEP_TIMEOUT_HEADROOM_SEC` on top so the exec's
      // deadline is the one that fires.
      const result = yield* step(
        "exec",
        () =>
          // The checkout is re-established INSIDE the retryable step, for the
          // same reason the staged path does it: a container recycled between
          // `checkout` and here takes the checkout with it, and the retry would
          // otherwise re-run the command in a directory that is gone.
          //
          // #128 left this path alone, reasoning that a single-exec run's
          // "exposure is one step rather than five". That was wrong twice over.
          // A container can be recycled between ANY two durable steps, and
          // `checkout` is a step earlier than this one by construction — so the
          // exposure is one BOUNDARY, which every run has. This repo's own gate
          // then died exactly that way: `working directory
          // '/workspace/<repo>' was missing at exec time`.
          ensureWorkspace({
            current: soleWorkspace,
            repo: input.repo,
            sha: input.sha,
            ...(input.image !== undefined ? { image: input.image } : {}),
            install,
            ...installSecrets,
          }).pipe(
            Effect.flatMap((ws) =>
              sandbox.exec({
                cwd: ws.dir,
                container: ws.container,
                command: soleCommand,
                // Per-dispatch `env` wins over a same-named config-store secret
                // — the more specific source overrides the global one.
                env: { ...secretEnv, ...input.env },
                // Same scrub as the staged path above and as `check` does.
                redactValues: secretValues,
                timeoutSec,
              }),
            ),
          ),
        { timeoutSec: stepTimeoutFor(timeoutSec), retries: PLATFORM_RETRIES, retryOn: RETRY_ON },
      );

      // upload-log — push the captured stdout/stderr to R2, get a signed URL.
      // No `container` here: `result.logPath` is the R2 object key the live
      // sandbox exec streamed the log to (artifact-r2.ts "R2-source-key mode"),
      // not a container filesystem path.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "step.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      // self-heal — see `maybeDispatchSelfHeal` above (shared with staged mode).
      yield* maybeDispatchSelfHeal(soleCommand, result, logUri);

      // fail-on-nonzero — webhook mode (no GHA job reads the exit code) flips a
      // non-zero exit into a red check via a typed `AcceptanceFailed` carrying
      // the log link, which the dispatcher renders under the failure summary
      // (issue #85). Action mode leaves the flag false: a failing test stays a
      // normal result surfaced as `exitCode` (the V0 contract, header note 2).
      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `Command \`${soleCommand}\` exited \`${result.exitCode}\`.`,
              "",
              `[View full test log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
