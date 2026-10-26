// `worker-deploy` — continuous deployment on default-branch push.
//
// The CD counterpart of `offload-test`: clone the pushed SHA, run the repo's
// deploy command (typically `pnpm build && wrangler deploy`) in a Sandbox
// container with credentials injected from the config store, upload the log,
// and post a green/red `flare-dispatch/worker-deploy` check on the deployed
// SHA. Pairs with `deploy-smoke` (post-deploy probe) the way CI pairs with CD.
//
// --- Pure webhook mode: `check_suite` as the push signal ----------------------
//
// The FlareDispatch App does not subscribe to `push` — and does not need to.
// GitHub creates a check suite for the head commit of every push and delivers
// `check_suite.requested` to apps with `checks: write`, so the App's existing
// subscription set already carries a per-push signal with `head_branch` +
// `head_sha` on it. The trigger gates on `head_branch === repository.
// default_branch`: feature-branch pushes (whose PRs `offload-test` /
// `pr-review` already cover) never reach this run.
//
// --- Unconfigured repos no-op green -------------------------------------------
//
// A webhook trigger fires for EVERY installed repo's default-branch push, and
// its `gate` is sync + payload-only — it cannot ask the config store whether
// the repo opted in. So opt-in is resolved in the run body: no
// `worker-deploy.command:<owner/repo>` in CONFIG_KV → the run returns
// `{ deployed: false, skippedReason: "not-configured" }` and the check stays
// green. There is deliberately NO dispatcher-wide command fallback (unlike
// `offload-test`): a deploy command is inherently per-repo, and a global
// default would deploy-storm every installed repo.
//
// --- Credentials --------------------------------------------------------------
//
// DEPRECATED, and this run is the case that retires it. ADR-0006 bars a
// long-lived credential from inside a container, and `CLOUDFLARE_API_TOKEN` in
// the deploy command's env is exactly that — readable by anything the repo's
// build runs, kept out of the log by `redactValues` but not out of the process.
// `wrangler deploy` authenticates its own HTTPS calls to `api.cloudflare.com`,
// so there is no artifact to write back: it ships on the `cf-api` grant profile
// instead, where the substrate's egress handler attaches the token to the
// outbound request and the container holds nothing. The env path below stays
// until the dispatcher consumes the facade, and goes at stage-2 exit.
// See apps/substrate/specs/credential-boundary.md.
//
// Until then, the contract is `offload-test` header note 3: secret *names* ride the
// config store, never the dispatch body. Webhook dispatches can't name
// secrets either (sync, payload-only `inputs`), so the run body resolves the
// env-var names from `worker-deploy.secrets:<owner/repo>` (comma-separated)
// and the optional config-store prefix from
// `worker-deploy.secret-prefix:<owner/repo>`, then loads the values with
// `loadSecrets({ required: true })` — INLINE, not in a `step(...)`, so
// plaintext credentials never land in a checkpointed step result. The
// resolve-config step checkpoints only the key *names*.
//
// Prefer Worker env for credential *values* (never put API tokens in KV):
//   wrangler secret put CLOUDFLARE_API_TOKEN
//   CLOUDFLARE_ACCOUNT_ID  — already a wrangler `vars` on the dispatcher
// `loadSecrets` resolves via the `secrets` capability (Worker string
// bindings only — no CONFIG_KV). Commands + secret *names* stay in KV.
//
// --- A deploy launches once ---------------------------------------------------
//
// A deploy is not idempotent the way a test is: each run of the command ships
// a new version. So the command runs as ONE process the sandbox owns
// (`durableExec`), not inside one long Workflow step. Holding a single step
// open for the whole deploy made it hostage to that step: a Workflows restart
// of the instance, a dropped sandbox connection, or a reset sandbox Durable
// Object failed the deploy even though the command itself was fine.
//
// Only the short steps that launch, observe, and finalize the process retry
// (platform failures only, never a returned exit code). `exec-start` claims
// the launch once at the durable owner (check-command.ts, `reserve`), so a
// retried start recovers the recorded intent and never starts a second
// process.
//
// A lost process — the container recycled mid-command — fails
// `SandboxProcessLost`, because the deploy may already have published. A
// dispatch whose command may run twice (one commit published again to the
// same preview name) sets `relaunchOnProcessLoss`, and the command relaunches
// once in a fresh container — only while the relaunch can still finish inside
// the run ceiling (`limits.maxDurationSec`), which would otherwise interrupt
// it mid-publish.
//
// The durable form applies at every exec timeout, short ones included: a
// Workflows restart or a dropped connection ends a short deploy's held step
// as surely as a long one's. Only without a durable owner does the command
// run as a single `exec` step, with `retries: 0` and a step timeout of the
// exec timeout plus headroom: a retry of that step would run the whole deploy
// again.
//
// --- Several deploys of one commit: `checkLabel` ------------------------------
//
// A repo can deploy one SHA more than once with different work — the webhook
// deploys its Workers, and an Action-mode dispatch deploys container-backed
// Workers after a GHA image build. Both would post `flare-dispatch/worker-deploy`
// and overwrite each other's verdict. A `checkLabel` names the second one
// `flare-dispatch/worker-deploy:<label>` (apps/dispatcher/src/check-name.ts),
// and folds into both the Action's `Idempotency-Key` and the direct-dispatch
// instance id, so it stays its own execution.
//
// A labelled dispatch that omits `command` reads ONLY
// `worker-deploy.command:<repo>:<label>` — never the unlabelled key. Unlike
// `check`'s ladder, falling back would re-run the webhook's deploy under a
// second name.
//
// --- Deploy ordering ----------------------------------------------------------
//
// Ordering is a dispatcher property, in two parts:
//
//   1. `serialize` puts every execution of one repo + branch + `checkLabel` in
//      one group (apps/dispatcher/src/workflow.ts, runtime-cf
//      serial-queue-d1.ts). At most one runs; a running deploy is never
//      cancelled. Before a dispatch joins the queue it reads the branch head:
//      a SHA that is not the head skips at once and supersedes nothing, so a
//      late or re-requested older commit cannot displace the head's waiting
//      deploy. A dispatch that IS the head supersedes every waiter that is
//      not (`neutral`, naming the head). With the head unknown, the newest
//      arrival supersedes older waiters.
//   2. `branch-head` — once this execution holds its group and a sandbox slot,
//      it reads the branch's head through the GitHub App. A head that is not
//      `sha` means a newer push landed; the run skips (`neutral`, naming the
//      head) before cloning, unless the dispatch sets `requireHead: false` (a
//      deliberate rollback). The head is also handed to the command:
//
//        FLAREDISPATCH_BRANCH            the branch, or "" when not dispatched
//        FLAREDISPATCH_BRANCH_HEAD_SHA   the head at dequeue, or "" when unknown
//        FLAREDISPATCH_SHA               the commit being deployed
//
//      Empty means UNKNOWN (no branch, App uncredentialed, lookup failed) —
//      never "matches". The checkout's `origin` carries no credential
//      (packages/runtime-cf/src/sandbox-cf.ts, `scrubCloneCredential`), so a
//      command cannot look the head up itself on a private repo.
//
// Spec: specs/02-runs.md § worker-deploy, specs/04-gha-integration.md
// § Webhook mode.

import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  config,
  defineRun,
  github,
  io,
  RunSkipped,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  durableExec,
  ensureWorkspace,
  loadSecrets,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const WorkerDeployInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String, // the pushed head SHA — what gets checked out + deployed
  /** Branch the push landed on — context for logs/summaries only. */
  branch: Schema.optional(Schema.String),
  /**
   * The deploy command, e.g. `pnpm install --frozen-lockfile && pnpm build &&
   * pnpm exec wrangler deploy`. OPTIONAL: a webhook-mode dispatch omits it and
   * the run body resolves `worker-deploy.command:<owner/repo>` from CONFIG_KV.
   * No per-repo key → the run no-ops green (see header).
   */
  command: Schema.optional(Schema.String),
  /**
   * Names a second deploy of the same commit: the check-run posts as
   * `flare-dispatch/worker-deploy:<label>` and a command-less dispatch reads
   * `worker-deploy.command:<repo>:<label>` (see header). Same pattern as
   * `check`'s label, so a malformed one is a 400 at dispatch.
   */
  checkLabel: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  ),
  image: Schema.optional(Schema.String), // container image override
  /** Run the R2-cached dependency install after the clone. */
  install: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Non-sensitive env only — dispatch inputs are persisted. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * Env-var names resolved from the config store into the command's env.
   * Empty on webhook dispatches — the run body falls back to
   * `worker-deploy.secrets:<owner/repo>` (comma-separated names).
   *
   * @deprecated ADR-0006 — this run is the credential boundary's acceptance
   * case. `wrangler deploy` reaches `api.cloudflare.com`, so it ships on the
   * `cf-api` grant profile: the substrate's egress handler attaches
   * `CLOUDFLARE_API_TOKEN` to the request, and the container holds nothing
   * (apps/substrate/specs/credential-boundary.md). Removed at stage-2 exit.
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
  /**
   * Skip (neutral) when `branch`'s head is no longer `sha` at dequeue time.
   * Default true; a rollback that deploys an older commit on purpose sets it
   * false. No effect without `branch`, or when the head cannot be read.
   */
  requireHead: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  /** The deploy command's timeout. Omitted → `worker-deploy.timeoutSec:<repo>` → 900. */
  timeoutSec: Schema.optional(Schema.Number),
  /**
   * Fail the run Effect (→ red check) on a non-zero exit. Webhook mode sets
   * this true — the check-run is the only signal a deploy failed. Action mode
   * defaults false and reads `exitCode`, mirroring `offload-test`.
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
  /**
   * Relaunch the command once when the sandbox loses its process (its
   * container was recycled mid-command). Only for a command that may run
   * twice: one commit published again to the same preview name. Default
   * false — a lost process fails the check, and a person retries it.
   */
  relaunchOnProcessLoss: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});

const WorkerDeployOutput = Schema.Struct({
  /** True when the deploy command ran and exited 0. */
  deployed: Schema.Boolean,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /** Signed R2 URL to the deploy log. Absent when the run no-oped. */
  logUri: Schema.optional(Schema.String),
  /** Why the run no-oped (e.g. "not-configured"). Absent when it deployed. */
  skippedReason: Schema.optional(Schema.String),
});

/** Default `exec` timeout — a build + `wrangler deploy` fits comfortably. */
const TIMEOUT_SEC_DEFAULT = 900;

/** The run ceiling (`limits.maxDurationSec`); a relaunch must fit inside it. */
const MAX_DURATION_SEC = 1800;

/** The env names the deploy command reads the dequeue-time branch head from. */
export const BRANCH_ENV = "FLAREDISPATCH_BRANCH";
export const BRANCH_HEAD_SHA_ENV = "FLAREDISPATCH_BRANCH_HEAD_SHA";
export const DEPLOY_SHA_ENV = "FLAREDISPATCH_SHA";

/**
 * The serialization group: one per repo, branch, and label. The branch keeps a
 * staging deploy from superseding a pending production one; the label keeps a
 * second deploy of one commit from waiting on the first.
 */
export const serialGroup = (repo: string, branch?: string, checkLabel?: string): string =>
  `worker-deploy:${repo}${branch !== undefined && branch !== "" ? `@${branch}` : ""}${
    checkLabel !== undefined ? `:${checkLabel}` : ""
  }`;

/** The branch head, or `undefined` when it cannot be read — never a placeholder. */
const readHead = (repo: string, branch: string) =>
  github.branchHead({ repo, branch }).pipe(
    Effect.map((sha): string | undefined => sha),
    Effect.orElseSucceed(() => undefined),
  );

/** `sha` is the head, allowing an abbreviated dispatch SHA. */
const isHead = (head: string, sha: string): boolean => {
  const s = sha.toLowerCase();
  return head === s || (s.length >= 7 && head.startsWith(s));
};

/** Decoded input — pins the trigger's `inputs` return to the full shape. */
type WorkerDeployI = Schema.Schema.Type<typeof WorkerDeployInput>;

/**
 * CONFIG_KV keys — all strictly per-repo (see header: no global fallback). A
 * labelled dispatch's command key is its own, with no unlabelled fallback.
 */
const commandKey = (repo: string, checkLabel?: string): string =>
  checkLabel === undefined
    ? `worker-deploy.command:${repo}`
    : `worker-deploy.command:${repo}:${checkLabel}`;
const secretsKey = (repo: string): string => `worker-deploy.secrets:${repo}`;
const secretPrefixKey = (repo: string): string => `worker-deploy.secret-prefix:${repo}`;

/**
 * Per-repo exec timeout, for webhook dispatches — the trigger's `inputs` is
 * sync + payload-only and cannot carry one, so without this key webhook mode
 * is pinned to 900s:
 *
 *   wrangler kv key put --binding=CONFIG_KV "worker-deploy.timeoutSec:owner/repo" "1500"
 *
 * A labelled dispatch reads `…:<repo>:<label>` first and falls back to the
 * repo key — a timeout, unlike a command, is safe to share. A dispatch that
 * passes `timeoutSec` wins over both.
 */
const timeoutKeys = (repo: string, checkLabel: string | undefined): readonly string[] =>
  checkLabel === undefined
    ? [`worker-deploy.timeoutSec:${repo}`]
    : [`worker-deploy.timeoutSec:${repo}:${checkLabel}`, `worker-deploy.timeoutSec:${repo}`];

/** A positive integer, or `undefined` for absent/garbage — never `NaN`. */
const parseIntConfig = (raw: string | undefined): number | undefined => {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const workerDeploy = defineRun({
  name: "worker-deploy",
  // 1.2.0 — additive: per-group serialization, the dequeue-time head check
  // (`requireHead`), and the `FLAREDISPATCH_*` head env.
  // 1.3.0 — additive: `exec` runs as a durable process, and the opt-in
  // `relaunchOnProcessLoss`.
  version: "1.3.0",

  // Webhook-mode trigger — `check_suite.requested` is GitHub's per-push signal
  // to checks-writing Apps (see header). Gated to the repo's default branch.
  triggers: [
    {
      event: "check_suite",
      actions: ["requested"],
      // Instance id `worker-deploy_{repo_}_{sha12}` — dedups webhook
      // redeliveries of one push. It does NOT collapse with an Action-mode
      // dispatch: the Action sends `Idempotency-Key: worker-deploy-{repo_}-{sha12}`
      // (hyphens, actions/flare-dispatch-action/dispatch.sh), a distinct id, so
      // both deploys run. Only a direct dispatch WITHOUT that header lands on
      // this id (routes/dispatch.ts `semanticInstanceId`).
      idempotencyKey: ({ payload }) =>
        `worker-deploy:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.check_suite?.head_sha ?? "").slice(0, 12)}`,
      gate: ({ payload }) =>
        typeof payload.check_suite?.head_branch === "string" &&
        payload.check_suite.head_branch === payload.repository?.default_branch,
      inputs: ({ payload }): WorkerDeployI => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.check_suite?.head_sha ?? ""),
        branch: String(payload.check_suite?.head_branch ?? ""),
        // The check-run is the only failure signal in webhook mode.
        failOnNonZeroExit: true,
        // Decoded-shape defaults the trigger return must restate.
        install: false,
        secrets: [],
        requireHead: true,
        relaunchOnProcessLoss: false,
      }),
    },
  ],

  // The branch head is the group's current revision: a dispatch of a commit
  // that is no longer the head skips before it joins the queue, so a late or
  // re-requested older commit never displaces the head's waiting deploy.
  serialize: (input) => ({
    group: serialGroup(input.repo, input.branch, input.checkLabel),
    revision: input.sha,
    ...(input.requireHead && input.branch !== undefined && input.branch !== ""
      ? { current: readHead(input.repo, input.branch) }
      : {}),
  }),

  inputs: WorkerDeployInput,
  outputs: WorkerDeployOutput,

  // The command key `resolve-config` reads — the receiver skips a repo without
  // it (specs/adr/0007-cost-efficient-execution.md § Dispatch only work).
  optIn: ({ input }) =>
    input.command !== undefined ? [] : [commandKey(input.repo, input.checkLabel)],

  limits: {
    maxDurationSec: MAX_DURATION_SEC,
    // A deploy someone waits on: admitted ahead of batch work.
    admissionClass: "interactive",
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-config — the per-repo deploy command, exec timeout, and secret
      // key NAMES (never values: this step's return is checkpointed). Missing
      // command → the repo hasn't opted in; no-op green rather than failing
      // every push of every installed repo. `startedAt` is the body's first
      // checkpointed clock, which the relaunch budget counts from.
      const cmdKey = commandKey(input.repo, input.checkLabel);
      const cfg = yield* step("resolve-config", () =>
        Effect.gen(function* () {
          const command = input.command ?? (yield* config.get(cmdKey));
          const timeoutSec =
            input.timeoutSec ??
            (yield* Effect.reduce(
              timeoutKeys(input.repo, input.checkLabel),
              undefined as number | undefined,
              (found, key) =>
                found !== undefined
                  ? Effect.succeed(found)
                  : config.get(key).pipe(Effect.map(parseIntConfig)),
            ));
          const secretNames =
            input.secrets.length > 0
              ? [...input.secrets]
              : ((yield* config.get(secretsKey(input.repo))) ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
          const secretPrefix =
            input.secretPrefix ?? (yield* config.get(secretPrefixKey(input.repo)));
          return { command, timeoutSec, secretNames, secretPrefix, startedAt: yield* io.now };
        }),
      );
      if (cfg.command === undefined || cfg.command.trim().length === 0) {
        yield* io.log(
          "warn",
          `worker-deploy: no \`${cmdKey}\` in the config store — repo not opted in, skipping`,
        );
        return {
          deployed: false,
          exitCode: 0,
          durationMs: 0,
          skippedReason: "not-configured",
        };
      }
      const command = cfg.command;

      // branch-head — the tip of the branch now that this execution holds its
      // serialization group. Any failure is "unknown" (""), never a match: the
      // command decides whether unknown blocks it (see header).
      const branch = input.branch !== undefined && input.branch !== "" ? input.branch : undefined;
      const head =
        branch === undefined
          ? { sha: "" }
          : yield* step("branch-head", () =>
              github.branchHead({ repo: input.repo, branch }).pipe(
                Effect.map((sha) => ({ sha })),
                Effect.catchAll((e) =>
                  io
                    .log(
                      "warn",
                      `worker-deploy: head of ${branch} unreadable (GitHub ${e.status} ${e.reason}) — ${BRANCH_HEAD_SHA_ENV} is empty`,
                    )
                    .pipe(Effect.as({ sha: "" })),
                ),
              ),
            );
      if (input.requireHead && head.sha !== "" && !isHead(head.sha, input.sha)) {
        return yield* Effect.fail(
          new RunSkipped({
            reason: `superseded by ${head.sha.slice(0, 12)} — ${branch} moved past ${input.sha.slice(0, 12)} before this deploy started`,
          }),
        );
      }

      // checkout — container + clone at the pushed SHA (+ optional cached
      // install), same opening move as offload-test.
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          image: input.image,
          install: input.install,
        }),
      );

      // load-secrets — INLINE (never in a step): plaintext credentials must
      // not land in checkpointed Workflow state. `required: true` — a deploy
      // missing its credentials must fail fast + legibly, not half-run.
      const secretEnv = yield* loadSecrets(cfg.secretNames, {
        prefix: cfg.secretPrefix,
        required: true,
      });

      // exec — the deploy itself. A non-zero exit is a normal ExecResult here;
      // the failOnNonZeroExit branch below decides whether it reds the check.
      // It launches once (see header § A deploy launches once): a durable
      // process whose launch and observation steps retry platform failures,
      // and a single `exec` step with `retries: 0` without a durable owner.
      const execTimeoutSec = cfg.timeoutSec ?? TIMEOUT_SEC_DEFAULT;
      const { result } = yield* durableExec({
        name: "exec",
        workspace: { container, dir },
        // A container recycled before the launch takes the checkout with it;
        // rebuilding it publishes nothing.
        ensure: (current) =>
          ensureWorkspace({
            current,
            repo: input.repo,
            sha: input.sha,
            ...(input.image !== undefined ? { image: input.image } : {}),
            install: input.install,
          }),
        exec: (ws) => ({
          cwd: ws.dir,
          command,
          // Per-dispatch `env` wins over a same-named config-store secret;
          // the head env wins over both, so no dispatch can spoof it.
          env: {
            ...secretEnv,
            ...input.env,
            [BRANCH_ENV]: branch ?? "",
            [BRANCH_HEAD_SHA_ENV]: head.sha,
            [DEPLOY_SHA_ENV]: input.sha,
          },
          // Scrub secret VALUES from the captured log before it is persisted,
          // in case the command echoes its env. Not hypothetical here: a deploy
          // command is the one that carries a cloud provider's write-scoped API
          // token, and `wrangler`-class tools print their environment on some
          // error paths. The log lands in R2 on a stable path (artifact TTLs are
          // not yet enforced), so a leak there is durable.
          redactValues: Object.values(secretEnv),
          timeoutSec: execTimeoutSec,
        }),
        relaunches: input.relaunchOnProcessLoss ? 1 : 0,
        // A relaunch the run ceiling would cut short dies mid-publish.
        relaunchDeadlineMs: cfg.startedAt + MAX_DURATION_SEC * 1000,
        // Durable at any length: the single step cannot retry a lost attempt.
        minDurableTimeoutSec: 0,
        singleStepRetries: 0,
      });

      // upload-log — the deploy log as a signed R2 artifact.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "step.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      if (input.failOnNonZeroExit && result.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `Deploy command \`${command}\` exited \`${result.exitCode}\` — the push to ${
                input.branch ?? "the default branch"
              } is NOT deployed.`,
              "",
              `[View full deploy log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        deployed: result.exitCode === 0,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
