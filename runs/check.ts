// `check` — the universal, opt-in command gate.
//
// Catalog counterpart of `oxlint` for clients who do not want Oxc. Same
// PR-gate role (clone → run one command → upload log → green/red
// `flare-dispatch/check`), but the command is free-form: `pnpm lint`,
// `npx eslint .`, `npx biome check .`, `cargo clippy --workspace`, etc.
//
// `oxlint` stays the install-free, hardcoded Oxc gate — droppable on any
// JS/TS repo with no opt-in. `check` is the gate when the client picks
// their own tool, and therefore MUST opt in.
//
// --- Opt-out by default (worker-deploy shape) ---------------------------------
//
// A webhook trigger fires for EVERY installed repo's PR push, and its `gate`
// is sync + payload-only — it cannot ask the config store whether the repo
// opted in. So opt-in is resolved in the run body: no
// `check.command:<owner/repo>` in CONFIG_KV → the run returns
// `{ exitCode: 0, skippedReason: "not-configured" }` and the check stays
// green. There is deliberately NO dispatcher-wide command fallback (unlike
// `offload-test`): a global default would turn every installed repo's PRs
// into a lint storm.
//
// --- Credentials + the untrusted-PR-code trust boundary -----------------------
//
// Same contract as `offload-test` header note 3: secret *names* ride the
// dispatch / config surface, never plaintext values. `loadSecrets` resolves
// Worker secret bindings INLINE (not in a `step`) — BEFORE `checkout`, so a
// missing credential fails before paying for a clone/container — and
// credentials never land in a durable Workflow checkpoint. Per-dispatch `env`
// wins over a same-named secret.
//
// The webhook trigger below hard-codes `secrets: []` and — unlike
// `worker-deploy` — this run has NO CONFIG_KV secrets fallback keyed by repo.
// So a PR-triggered dispatch can NEVER carry secrets: the only way `secrets`
// is non-empty is an explicit Action-mode dispatch, which the OPERATOR'S OWN
// CI controls. That CI still executes the command against the caller-selected
// `sha` — an untrusted fork PR's commit can rewrite the lint config/scripts
// this run executes — so an operator must not dispatch `check` with `secrets`
// from a workflow triggered on `pull_request` for repos that accept
// external/fork PRs (the same guidance GitHub gives for `pull_request_target`
// + secrets). As defense in depth, every resolved secret VALUE is also
// scrubbed from the captured log (`redactValues` below) before it is
// persisted, so a command that echoes its env cannot leak a credential
// through the log's signed URL. See `runs/README.md` § Secrets and logs.
//
// Determinism: `durationMs` comes from the checkpointed `ExecResult`; the
// body calls no `Date.now()` / `crypto.randomUUID()`.

import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  config,
  defineRun,
  io,
  sandbox,
  Sandbox,
  checkpointSleep,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  loadSecrets,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const CheckInput = Schema.Struct({
  /**
   * `owner/name`. Constrained to GitHub's legal charset — which excludes `:` —
   * because the CONFIG_KV command key is `check.command:<repo>[:<label>]` and
   * an unconstrained `repo` makes those segments ambiguous: a dispatch naming
   * repo `owner/name:codegen` with no label would resolve the key belonging to
   * `owner/name`'s `codegen` gate. Rejecting `:` at the schema keeps one repo's
   * config unreachable from another's dispatch.
   */
  repo: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/)),
  sha: Schema.String,
  /**
   * The check command, e.g. `pnpm lint` / `npx eslint .` / `cargo clippy`.
   * OPTIONAL: a webhook-mode dispatch omits it and the run body resolves
   * `check.command:<owner/repo>` from CONFIG_KV. No per-repo key → the run
   * no-ops green (see header).
   */
  command: Schema.optional(Schema.String),
  /**
   * Distinguishes this gate from the repo's OTHER gates. A repo with more than
   * one deterministic check — a source guard, `shellcheck`, a codegen-drift
   * check — dispatches `check` once per gate, and without a label all of those
   * land as check-runs named `flare-dispatch/check`, which branch protection
   * cannot require individually. Two effects:
   *   - the check-run becomes `flare-dispatch/check:<label>` (check-name.ts),
   *     so each gate is separately requirable;
   *   - the CONFIG_KV lookup prefers `check.command:<owner/repo>:<label>`, so
   *     each gate carries its own command.
   * Omit for a repo's single default gate — the behaviour before this input
   * existed, unchanged.
   *
   * The pattern is enforced here so a malformed label is a clean 400 at
   * dispatch rather than a check-run whose name silently doesn't match what an
   * operator typed into branch protection.
   */
  checkLabel: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  ),
  /** Optional bounded queue wait for dispatched long-running matrix checks. */
  admissionMaxQueueAgeSec: Schema.optional(Schema.Number),
  image: Schema.optional(Schema.String), // container image override
  /** Run the R2-cached dependency install after the clone. */
  install: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /**
   * Non-sensitive env only. Dispatch inputs are persisted (executions row +
   * Workflow params) — never put credentials here. Same contract as
   * `offload-test` / `worker-deploy`; see `runs/README.md`.
   */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Config-store / Worker-secret keys whose values are injected — as env vars
   * of the same name — into the command's env. Empty when the command needs
   * no credentials. See `loadSecrets` + header.
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
   * @deprecated Ignored by `loadSecrets` (Worker bindings are bare names).
   * Kept so Action inputs / call sites match `offload-test`.
   */
  secretPrefix: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number), // default 600
  /**
   * Fail the run Effect (→ red `flare-dispatch/check` check) on a non-zero
   * exit. Webhook mode sets this true — the check-run is the only signal.
   * Action mode defaults false and reads `exitCode`, mirroring `offload-test`.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
});

const CheckOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /** Signed R2 URL to the check log. Absent when the run no-oped. */
  logUri: Schema.optional(Schema.String),
  /** Why the run no-oped (e.g. "not-configured"). Absent when the command ran. */
  skippedReason: Schema.optional(Schema.String),
});

/** Decoded input — pin trigger `inputs` to this so `defineRun` does not infer `I` from the narrower webhook return. */
type CheckI = Schema.Schema.Type<typeof CheckInput>;

/** Default `exec` timeout — lint is usually fast; install + slow tools get headroom via `timeoutSec`. */
const DEFAULT_TIMEOUT_SEC = 600;

/**
 * Headroom added to the `exec` timeout to derive the Workflow STEP timeout, so
 * `sandbox.exec`'s own deadline fires first (a clean `ExecTimeout` with the
 * log streamed so far) instead of the platform hard-killing the step at the
 * same instant. Unclamped, same reasoning as offload-test's constant.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

/**
 * Platform-failure retries — see the `exec` step. A verdict is never retried:
 * a command that runs and exits non-zero is a normal `ExecResult`, so no class
 * here can reach one.
 *
 * `StepFailed` is included because a platform kill leaves no Effect `Cause` to
 * read a tag from, and the runner falls back to that name — so listing only
 * `ExecFailed` left the purely-platform failure as the one thing not retried.
 *
 * `CheckoutFailed` is included because `ensureWorkspace` re-clones inside this
 * step, in the same weather that destroyed the checkout. A transient clone
 * failure there would end the step non-retryably, one call short of the
 * recovery it was invoked to perform.
 */
const PLATFORM_RETRIES = 3;
const RETRY_ON = ["ExecFailed", "StepFailed", "CheckoutFailed"] as const;

/** CONFIG_KV key — strictly per-repo (see header: no global fallback). */
const commandKey = (repo: string): string => `check.command:${repo}`;

/**
 * The CONFIG_KV lookup ladder, most specific first. Unlabelled dispatches read
 * the single per-repo key exactly as before; a labelled one prefers its own key
 * and falls back to the repo's default gate, so adding a second gate to a repo
 * never requires re-keying the first.
 *
 *   wrangler kv key put --binding=CONFIG_KV \
 *     "check.command:owner/repo:codegen" "pnpm generate && git diff --exit-code"
 *
 * Still NO dispatcher-wide rung — the header's reasoning is unchanged: a global
 * default would turn every installed repo's PRs into a lint storm.
 */
const commandKeys = (repo: string, checkLabel: string | undefined): readonly string[] =>
  checkLabel === undefined
    ? [commandKey(repo)]
    : [`${commandKey(repo)}:${checkLabel}`, commandKey(repo)];

/**
 * Per-repo `exec` timeout, same ladder as the command.
 *
 * The webhook trigger's `inputs` is sync and payload-only, so it cannot carry a
 * per-repo timeout — it omits the field and the body falls back to
 * {@link DEFAULT_TIMEOUT_SEC} (600). That default suits the linters this gate
 * was built for and is far too short for a command that compiles: a repo whose
 * `check.command` is a cold native build gets killed mid-compile with no way to
 * say otherwise, and webhook mode is exactly the mode with no other channel.
 *
 * `offload-test` already resolves `offload-test.timeoutSec:<repo>` for the same
 * reason; this is that key, one run over. A dispatch that passes `timeoutSec`
 * still wins. The run's `maxDurationSec` bounds the whole body, so a timeout
 * above what remains of it ends as `RunDurationExceeded`, not `ExecTimeout`.
 */
const timeoutKeys = (repo: string, checkLabel: string | undefined): readonly string[] =>
  checkLabel === undefined
    ? [`check.timeoutSec:${repo}`]
    : [`check.timeoutSec:${repo}:${checkLabel}`, `check.timeoutSec:${repo}`];

/**
 * A positive integer, or `undefined` for absent/garbage. Deliberately does NOT
 * substitute the default on a malformed value's behalf — the caller does that,
 * so a typo'd key degrades to the documented default rather than to `NaN`,
 * which would reach `sandbox.exec` as a timeout that never fires.
 */
const parseIntConfig = (raw: string | undefined): number | undefined => {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const check = defineRun({
  name: "check",
  // 1.1.0 — additive: `checkLabel` + the labelled CONFIG_KV rung. An existing
  // unlabelled dispatch resolves the same key, names the same check-run, and
  // gets the same instance id as under 1.0.0.
  version: "1.1.0",

  inputs: CheckInput,
  outputs: CheckOutput,

  // Webhook-mode trigger — the zero-GHA check gate. Fires on every PR push;
  // the run body resolves the command from CONFIG_KV (`command` is omitted
  // here because this callback is sync + payload-only). Unconfigured repos
  // no-op green. `failOnNonZeroExit: true` because the check-run is the only
  // pass/fail signal. Gate mirrors oxlint / offload-test: skip drafts +
  // dependabot.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `check:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.pull_request?.head?.sha ?? "").slice(0, 12)}`,
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      // Annotated return type — without it, `defineRun` infers `I` from this
      // object literal and drops optional fields (`command`, `image`, …).
      inputs: ({ payload }): CheckI => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // command omitted — resolved from CONFIG_KV in the run body.
        failOnNonZeroExit: true,
        // Decoded-shape defaults the trigger return must restate.
        install: false,
        secrets: [],
      }),
    },
  ],

  limits: {
    // Run-body wall-time ceiling, enforced by the dispatcher: one full 2700 s
    // exec (the per-stage ceiling a fan-out gate passes) plus checkout, upload
    // and the step headroom, with every retry drawing on the same budget.
    maxDurationSec: 4500,
    admissionMaxQueueAgeSec: (input) =>
      Math.min(90 * 60, Math.max(20 * 60, input.admissionMaxQueueAgeSec ?? 20 * 60)),
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-config — the per-repo check command. Missing → the repo hasn't
      // opted in; no-op green rather than failing every PR of every installed
      // repo.
      const keys = commandKeys(input.repo, input.checkLabel);
      // Resolved together in ONE step, not two: both are webhook-mode concerns
      // (a dispatch that passes `command` also passes `timeoutSec` if it cares),
      // so folding them keeps the step shape the suite pins and adds no config
      // read for callers that supply everything.
      const { command, timeoutSec } = yield* step("resolve-config", () =>
        Effect.gen(function* () {
          const resolvedTimeout =
            input.timeoutSec ??
            (yield* Effect.reduce(
              timeoutKeys(input.repo, input.checkLabel),
              undefined as number | undefined,
              (found, key) =>
                found !== undefined
                  ? Effect.succeed(found)
                  : config.get(key).pipe(Effect.map(parseIntConfig)),
            ));
          if (input.command !== undefined)
            return { command: input.command, timeoutSec: resolvedTimeout };
          const resolvedCommand = yield* Effect.reduce(
            keys,
            undefined as string | undefined,
            (found, key) =>
              found !== undefined
                ? Effect.succeed(found)
                : config
                    .get(key)
                    .pipe(
                      Effect.map((value) =>
                        value !== undefined && value.trim().length > 0 ? value : undefined,
                      ),
                    ),
          );
          return { command: resolvedCommand, timeoutSec: resolvedTimeout };
        }),
      );
      if (command === undefined || command.trim().length === 0) {
        yield* io.log(
          "warn",
          `check: no ${keys.map((k) => `\`${k}\``).join(" / ")} in the config store — repo not opted in, skipping`,
        );
        return {
          exitCode: 0,
          durationMs: 0,
          skippedReason: "not-configured",
        };
      }

      // load-secrets — resolve named Worker secrets BEFORE provisioning a
      // container: a missing credential fails fast, before paying for a
      // clone (see header). INLINE (never in a step): plaintext must not land
      // in checkpointed Workflow state. No-op when `secrets` is empty.
      // `required: true` — a named-but-unset credential fails before checkout.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // checkout — container + clone at the SHA (+ optional cached install).
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install: input.install,
        }),
      );

      // exec — run the check command. A non-zero exit is a normal ExecResult
      // here; the failOnNonZeroExit branch below decides whether it reds the
      // check. `result` is the checkpointed step output — replay restores it
      // identically, which is why `durationMs` is read from it.
      // The STEP timeout derives from the exec's plus headroom — see the same
      // note in `offload-test`. Two timeouts that must agree are one timeout
      // with a bug in it: leave the step's unset and its 600s default silently
      // wins over a configured `check.timeoutSec`, surfacing as
      // `WorkflowTimeoutError` from a limit the repo's config never mentions.
      // A red check is not a transient — but a PLATFORM failure is, and the two
      // are different channels here. A command that runs and exits non-zero
      // comes back as a normal `ExecResult` and is decided below; only
      // `ExecFailed` / `ExecTimeout` fail the Effect. So `retryOn: ExecFailed`
      // cannot retry a returned verdict. A lost synchronous response leaves
      // the command outcome uncertain; long checks recover a durable intent.
      //
      // Which is not hypothetical. Observed on a consumer's PR: a 40-second
      // check reported `ExecFailed: exec failed (exit -1): HTTP error! status:
      // 500` — the container, not the code — and reported it as the repo's
      // verdict. `retries: 0` made a platform hiccup indistinguishable from a
      // lint error, on the run whose whole job is to be believed.
      //
      // `ExecTimeout` is deliberately NOT retryable: a command that outran its
      // ceiling will outrun it again, and three more attempts cost the ceiling
      // three more times.
      const effectiveTimeoutSec = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      const service = yield* Sandbox;
      const durable = service.checkCommand;
      const result =
        durable !== undefined && effectiveTimeoutSec > DEFAULT_TIMEOUT_SEC
          ? yield* Effect.gen(function* () {
              const ws = yield* step("exec-workspace", () =>
                ensureWorkspace({
                  current: { container, dir },
                  repo: input.repo,
                  sha: input.sha,
                  ...(input.image !== undefined ? { image: input.image } : {}),
                  install: input.install,
                }),
              );
              const opts = {
                cwd: ws.dir,
                container: ws.container,
                command,
                env: { ...secretEnv, ...input.env },
                redactValues: Object.values(secretEnv),
                timeoutSec: effectiveTimeoutSec,
              };
              const handle = yield* step("exec-prepare", () =>
                durable.prepare({ ...opts, stepName: "exec" }),
              );
              // Only the owner intent can authorize launch; retries recover this handle.
              yield* step("exec-start", () => durable.start(handle, opts), {
                timeoutSec: 60,
                retries: PLATFORM_RETRIES,
                retryOn: RETRY_ON,
              });
              const maxPolls = Math.ceil(effectiveTimeoutSec / 5) + 3;
              for (let i = 0; i < maxPolls; i++) {
                const status = yield* step(
                  `exec-observe-${i}`,
                  () => durable.observe(handle, opts),
                  { timeoutSec: 60, retries: PLATFORM_RETRIES, retryOn: RETRY_ON },
                );
                if (status.state !== "running") break;
                yield* checkpointSleep(`exec-sleep-${i}`, 5000);
              }
              return yield* step("exec-finalize", () => durable.finalize(handle, opts), {
                timeoutSec: 120,
                retries: PLATFORM_RETRIES,
                retryOn: RETRY_ON,
              });
            })
          : yield* step(
              "exec",
              () =>
                // The checkout is re-established INSIDE the retryable step, because a
                // container recycled between steps takes it with it and the retry
                // would otherwise re-run the command in a directory that is gone —
                // three times, reporting the missing directory as the repo's verdict.
                ensureWorkspace({
                  current: { container, dir },
                  repo: input.repo,
                  sha: input.sha,
                  ...(input.image !== undefined ? { image: input.image } : {}),
                  install: input.install,
                }).pipe(
                  Effect.flatMap((ws) =>
                    sandbox.exec({
                      cwd: ws.dir,
                      container: ws.container,
                      command,
                      // Per-dispatch `env` wins over a same-named Worker secret.
                      env: { ...secretEnv, ...input.env },
                      // Defense in depth (header): scrub secret VALUES from the
                      // captured log before it's persisted, in case the command
                      // echoes its env.
                      redactValues: Object.values(secretEnv),
                      timeoutSec: effectiveTimeoutSec,
                    }),
                  ),
                ),
              {
                timeoutSec: effectiveTimeoutSec + STEP_TIMEOUT_HEADROOM_SEC,
                retries: PLATFORM_RETRIES,
                retryOn: RETRY_ON,
              },
            );

      // upload-log — push the captured stdout/stderr to R2, get a signed URL.
      // 30-day TTL matches the catalog (`oxlint` / `offload-test` / …); operators
      // must not print secrets from the check command (see runs/README.md).
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "check.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              // Name the specific gate — a repo running several must be able to
              // tell which one went red without opening the log.
              `\`${input.checkLabel === undefined ? "check" : `check:${input.checkLabel}`}\` — \`${command}\` exited \`${result.exitCode}\`; problems reported (or the command failed to run; see the log).`,
              "",
              `[View full check log ↗](${logUri})`,
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
