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
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  compileCacheCommand,
  compileCacheEnv,
  COMPILE_CACHE_ENDPOINT_KEY,
  COMPILE_CACHE_TOKEN_KEY,
  durableExec,
  isCompileCacheLane,
  ensureWorkspace,
  isRestorableEntry,
  loadSecrets,
  restorePrebuilt,
  workspace,
  type Workspace,
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
   * R2 cache entries restored into the container after the clone, and again
   * after a recycled container is re-cloned — e.g. a tool binary a parent run
   * built once (`prebuildCargoBinary`). Restore-only: a miss or a failed restore
   * leaves the paths absent, and the command decides what absence means. Each
   * entry's base lies under `/tmp`, outside the checkout.
   */
  restore: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        base: Schema.String,
        paths: Schema.Array(Schema.String),
      }).pipe(Schema.filter(isRestorableEntry)),
    ),
  ),
  /**
   * Compile Rust through the shared compile cache: the command runs under
   * `compileCacheCommand` (sccache as `RUSTC_WRAPPER`, statistics printed at
   * the end) with the endpoint and token the dispatcher injected. Without an
   * injected token the command runs unwrapped.
   */
  compileCache: Schema.optional(Schema.Boolean),
  /**
   * The compile-cache lane the token writes (primitives/compile-cache.ts
   * `CompileCacheLane`): `base` for a default-branch execution, `pr-<n>` for
   * pull request `n`'s. Absent, the token reads `base` and writes nothing.
   */
  compileCacheLane: Schema.optional(Schema.String.pipe(Schema.filter(isCompileCacheLane))),
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

/** Restore every requested cache entry into a fresh checkout's container. */
const restoreEntries = (
  ws: Workspace,
  entries: Schema.Schema.Type<typeof CheckInput>["restore"],
) =>
  Effect.forEach(entries ?? [], (entry) =>
    restorePrebuilt({ container: ws.container, dir: ws.dir, entry }),
  ).pipe(Effect.as(ws));

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
  // 1.2.0 — additive: `restore`. A dispatch without it runs as under 1.1.0.
  // 1.4.0 — additive: `compileCacheLane`. A dispatch without it reads the
  // compile cache and writes nothing.
  // 1.3.0 — additive: `compileCache`. A dispatch without it runs as under 1.2.0.
  version: "1.4.0",

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

  // The command keys `resolve-config` reads — the receiver skips a repo with
  // none of them (specs/adr/0007-cost-efficient-execution.md § Dispatch only
  // work). A webhook dispatch is unlabelled, so it reads `check.command:<repo>`.
  optIn: ({ input }) =>
    input.command !== undefined ? [] : commandKeys(input.repo, input.checkLabel),

  compileCache: (input) =>
    input.compileCache === true
      ? input.compileCacheLane !== undefined && isCompileCacheLane(input.compileCacheLane)
        ? input.compileCacheLane
        : "read-only"
      : undefined,

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

      // Compile-cache access, read INLINE like the secrets above: the token is
      // a credential and stays out of checkpointed state. The dispatcher mints
      // the same token on every invocation, so the command's fingerprint holds.
      const cacheEndpoint = input.compileCache === true ? yield* config.get(COMPILE_CACHE_ENDPOINT_KEY) : undefined;
      const cacheToken = input.compileCache === true ? yield* config.get(COMPILE_CACHE_TOKEN_KEY) : undefined;
      const cache =
        cacheEndpoint !== undefined && cacheEndpoint !== "" && cacheToken !== undefined && cacheToken !== ""
          ? { endpoint: cacheEndpoint, token: cacheToken }
          : undefined;
      if (input.compileCache === true && cache === undefined) {
        yield* io.log("warn", "check: compile cache requested but not injected — compiling without it");
      }
      const execCommand = cache === undefined ? command : compileCacheCommand(command, input.repo);
      const cacheEnv = cache === undefined ? {} : compileCacheEnv(cache);

      // checkout — container + clone at the SHA (+ optional cached install).
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install: input.install,
        }).pipe(Effect.flatMap((ws) => restoreEntries(ws, input.restore))),
      );

      // exec — run the check command. A non-zero exit is a normal ExecResult
      // here; the failOnNonZeroExit branch below decides whether it reds the
      // check. `durableExec` retries only platform failures (`ExecFailed`,
      // `StepFailed`, `CheckoutFailed`), never a returned verdict, and never
      // `ExecTimeout`: a command that outran its ceiling will outrun it again.
      // Observed on a consumer's PR: a 40-second check reported `ExecFailed:
      // exec failed (exit -1): HTTP error! status: 500` — the container, not
      // the code — as the repo's verdict, because the step did not retry.
      const { result } = yield* durableExec({
        name: "exec",
        workspace: { container, dir },
        // The checkout is re-established inside the retryable step: a container
        // recycled between steps takes it with it, and a retry would otherwise
        // re-run the command in a directory that is gone and report that as the
        // repo's verdict.
        ensure: (current) =>
          ensureWorkspace({
            current,
            repo: input.repo,
            sha: input.sha,
            ...(input.image !== undefined ? { image: input.image } : {}),
            install: input.install,
          }).pipe(
            // A re-cloned workspace lost what the checkout step restored.
            Effect.flatMap((ws) => (ws === current ? Effect.succeed(ws) : restoreEntries(ws, input.restore))),
          ),
        exec: (ws) => ({
          cwd: ws.dir,
          command: execCommand,
          // Per-dispatch `env` wins over a same-named Worker secret; the
          // compile-cache endpoint and token win over both.
          env: { ...secretEnv, ...input.env, ...cacheEnv },
          // Defense in depth (header): scrub secret VALUES from the captured
          // log before it's persisted, in case the command echoes its env.
          redactValues: [...Object.values(secretEnv), ...(cache === undefined ? [] : [cache.token])],
          timeoutSec: timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        }),
      });

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
