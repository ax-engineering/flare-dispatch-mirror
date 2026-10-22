// `oxlint` — the install-free lint gate.
//
// Clones a repo and runs oxlint (the Rust linter from the Oxc toolchain, part
// of the Vite/VoidZero stack now inside Cloudflare) in a Sandbox container,
// uploads the log to R2, and posts a green/red `flare-dispatch/oxlint` check.
//
// This is the CHEAPEST run in the catalog: oxlint needs NO `pnpm install` — it
// lints source directly, with no type information and no dependency resolution
// — so the body is just `checkout → exec → upload-log` with `install: false`
// and a sub-second Rust binary. That makes it the ideal fast pre-flight gate to
// require in branch protection BEFORE the expensive test / e2e / pr-review runs
// burn container minutes: a lint break fails in ~seconds, not after a full
// install + test cycle.
//
// Contract mirrors `offload-test` (specs/02-runs.md § 1, specs/03-dsl.md
// § Top-level shape) — the only differences are the baked-in command (oxlint,
// resolved from the catalog via `npx`, with one optional per-repo CONFIG_KV
// key, `oxlint.version:<repo>`) and that `failOnNonZeroExit` defaults ON: a
// lint finding has no other pass/fail signal, so a non-zero exit must turn the
// check red in every mode.
//
// Because it installs nothing and configures nothing, the gate is droppable on
// ANY repo — including one that never adopted oxlint (no `.oxlintrc.json`, no
// oxlint dependency), where it lints with oxlint's own defaults. The corollary
// is that it also lands on repos with NOTHING to lint (no JS/TS at all, or an
// all-gitignored tree), where oxlint exits 1 on an empty file set — a no-op the
// body reclassifies as a green `skipped`, never a red check. See `skipped` in
// the output contract and `isNothingToLint`.
//
// Determinism: like `offload-test`, the body reads `durationMs` from the
// checkpointed `exec` step result and calls no `Date.now()` / `crypto.randomUUID()`
// (specs/pm/plan.md § 6 "Run replay determinism").

import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  config,
  defineRun,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  isNothingToLint,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

/** Input contract — repo/sha plus oxlint knobs. */
const OxlintInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * Extra oxlint CLI args appended verbatim, e.g. `"--deny-warnings"` or a path
   * filter `"src"`. Empty by default — oxlint auto-discovers `.oxlintrc.json`
   * and lints the working tree.
   */
  args: Schema.optionalWith(Schema.String, { default: () => "" }),
  /**
   * Exact oxlint version to fetch via `npx`. OPTIONAL: a webhook dispatch omits
   * it and the run body resolves it from CONFIG_KV, falling back to
   * `VERSION_DEFAULT` — see `repoVersionKey`.
   *
   * A range or dist-tag (`"1"`, `"^1.74.0"`, `"latest"`) is accepted and
   * defeats the point: `npx` re-resolves it on every run, so what this gate
   * enforces becomes whatever the registry served that minute. Pass an exact
   * version. See `VERSION_DEFAULT` for what that costs when it is not.
   */
  version: Schema.optional(Schema.String),
  /**
   * Fail the run Effect (→ red `flare-dispatch/oxlint` check) on a non-zero
   * exit. Defaults ON — unlike `offload-test`, a lint run has no GHA step that
   * reads `exitCode`, so the check-run is the only signal and a finding must
   * turn it red. Set false to surface findings as a green check carrying the
   * count (advisory mode).
   */
  failOnNonZeroExit: Schema.optionalWith(Schema.Boolean, {
    default: () => true,
  }),
});

/** Output contract — `offload-test`'s shape plus the no-op signal. */
const OxlintOutput = Schema.Struct({
  /**
   * oxlint's exit — but NORMALIZED to 0 when there was nothing to lint (see
   * `skipped`). An Action-mode caller gates on this field the way it gates on
   * `offload-test`'s, so the one non-zero exit that is not a verdict must not
   * reach it.
   */
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the oxlint log
  /**
   * True when oxlint found NOTHING to lint — a repo with no JS/TS surface, an
   * all-gitignored tree, or an `args` filter matching no file. A clean pass over
   * zero files, not a clean pass over the repo: the distinction `exitCode: 0`
   * alone cannot carry, kept out of band so nothing reads a green check as
   * "oxlint vouched for this code".
   */
  skipped: Schema.Boolean,
});

/** Default `exec` timeout — lint is fast, so a tighter ceiling than tests. */
const TIMEOUT_SEC_DEFAULT = 300;

/**
 * The oxlint version this gate runs when nothing overrides it — an EXACT
 * version, never a range or a dist-tag.
 *
 * It was the major line `"1"` until 2026-08-18, which handed the registry the
 * power to change what this gate enforces with no commit, no PR and no review
 * on either side. oxlint selects rules by CATEGORY, and a minor release may
 * move a rule into `correctness`: 1.79.0 moved five React rules in, and every
 * consumer tracking `@1` went red within the hour — on every open PR at once,
 * for findings that predated all of them. Nothing in those PRs caused it, and
 * nothing in those repos could fix it, because the version lived here.
 *
 * A consumer's own lint step runs its PINNED devDependency, so a floating gate
 * also means the two lanes enforce different rule sets, with no signal of the
 * divergence until the day they disagree.
 *
 * Bumping this is a deliberate, reviewed change here — and a change that can
 * turn consumers red, so it belongs in its own PR. A consumer needing a
 * different version pins it per-repo (`repoVersionKey`) without waiting on a
 * release.
 */
export const VERSION_DEFAULT = "1.79.0";

/**
 * CONFIG_KV keys the run body resolves `version` from when a dispatch omits it
 * (webhook mode — the `pull_request` trigger's `inputs` is a sync,
 * payload-only callback that cannot read config). Per-repo wins over the
 * dispatcher-wide key, which wins over `VERSION_DEFAULT`:
 *
 *   wrangler kv key put --binding=CONFIG_KV "oxlint.version:owner/repo" "1.74.0"
 *
 * This is the whole of oxlint's per-repo config. The run still needs no
 * command, no install and no `.oxlintrc.json`, so it stays droppable on any
 * repo; the key exists so a consumer that a bump breaks can pin itself out of
 * it in one command instead of waiting on a deploy here.
 */
const VERSION_KEY = "oxlint.version";
const repoVersionKey = (repo: string): string => `${VERSION_KEY}:${repo}`;

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

export const oxlint = defineRun({
  name: "oxlint",
  version: "1.2.0",

  // Webhook-mode trigger — the zero-GHA lint gate. Fires on every PR push; the
  // run resolves oxlint from `npx`, so the sync, payload-only callback carries
  // no command. `failOnNonZeroExit: true` because the check-run is the only
  // pass/fail signal. Gate mirrors `offload-test`: skip drafts + dependabot.
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `oxlint:${String(payload.repository?.full_name ?? "unknown/unknown").replace(
          /\//g,
          "_",
        )}:${String(payload.pull_request?.head?.sha ?? "").slice(0, 12)}`,
      gate: ({ payload }) =>
        payload.pull_request?.draft !== true &&
        payload.pull_request?.user?.login !== "dependabot[bot]",
      // The return type is pinned to the schema's Type: with `version` omitted,
      // an unannotated object literal is also a valid candidate for the run's
      // input type, and TS infers the NARROWER one — which then drops `version`
      // from the `run` body's `input`.
      inputs: ({ payload }): typeof OxlintInput.Type => ({
        repo: String(payload.repository?.full_name ?? "unknown/unknown"),
        sha: String(payload.pull_request?.head?.sha ?? ""),
        // The decoded input type carries these (their schema defaults); the
        // trigger restates them since `inputs` returns the decoded shape.
        args: "",
        // `version` stays OMITTED so the run body resolves it from CONFIG_KV.
        // Restating a literal here would pin every repo the dispatcher serves
        // to one version again, unreachable from any of them.
        failOnNonZeroExit: true,
      }),
    },
  ],

  inputs: OxlintInput,
  outputs: OxlintOutput,

  limits: {
    // Wall-time ceiling — lint is cheap, but a cold `npx` fetch + a huge tree
    // gets headroom.
    maxDurationSec: 600,
    // A PR verdict someone waits on: admitted ahead of batch work.
    admissionClass: "interactive",
  },

  run: (input) =>
    Effect.gen(function* () {
      // resolve-version — a webhook dispatch omits `version` (its trigger
      // callback is sync and cannot read config), so resolve it here:
      // `oxlint.version:<repo>` → the dispatcher-wide `oxlint.version` →
      // `VERSION_DEFAULT`. Unlike `offload-test`'s command, an unresolvable
      // version is not a failure — the default always answers, so the gate
      // never needs configuring to work.
      //
      // The step is SKIPPED when the dispatch carried a version (the `??`
      // short-circuits before the `yield*`), so an Action-mode caller keeps the
      // historical `checkout → exec → upload-log` step shape.
      const version =
        input.version ??
        (yield* step("resolve-version", () =>
          Effect.gen(function* () {
            const perRepo = (yield* config.get(repoVersionKey(input.repo)))?.trim();
            if (perRepo !== undefined && perRepo.length > 0) return perRepo;
            const dispatcherWide = (yield* config.get(VERSION_KEY))?.trim();
            if (dispatcherWide !== undefined && dispatcherWide.length > 0) return dispatcherWide;
            return VERSION_DEFAULT;
          }),
        ));

      // checkout — acquire a container (default lean image; oxlint needs only
      // Node for `npx`), clone at the SHA. NO install: oxlint lints source
      // directly, so `node_modules` is never needed (the whole point — a
      // near-free gate).
      const { container, dir } = yield* step("checkout", () =>
        workspace({
          repo: input.repo,
          sha: input.sha,
          install: false,
        }),
      );

      // exec — fetch + run oxlint via `npx`. The args are appended verbatim;
      // the `.trim()` collapses the trailing space when `args` is empty.
      const command = `npx --yes oxlint@${version} ${input.args}`.trim();
      // Retries cover the PLATFORM, never the verdict. oxlint exiting non-zero
      // is a normal `ExecResult` decided below; only `ExecFailed` fails the
      // Effect, and that is the container rather than the code (observed
      // elsewhere as `exec failed (exit -1): HTTP error! status: 500`).
      const result = yield* step(
        "exec",
        () =>
          // Re-established INSIDE the retryable step: a container recycled
          // between steps takes the checkout with it, and the retry would
          // otherwise re-run `npx` in a directory that is gone — three times,
          // reporting the missing directory as the repo's lint verdict.
          ensureWorkspace({
            current: { container, dir },
            repo: input.repo,
            sha: input.sha,
            install: false,
          }).pipe(
            Effect.flatMap((ws) =>
              sandbox.exec({
                cwd: ws.dir,
                container: ws.container,
                command,
                timeoutSec: TIMEOUT_SEC_DEFAULT,
              }),
            ),
          ),
        { retries: PLATFORM_RETRIES, retryOn: RETRY_ON },
      );

      // upload-log — push the oxlint output to R2, get a signed URL.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "oxlint.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      // nothing-to-lint — oxlint exits 1, with no finding, when the tree holds
      // no file it can lint: a repo with no JS/TS at all (Rust/Python/Go/docs),
      // a tree whose sources are entirely gitignored, or an `args` path filter
      // matching nothing. This run is the INSTALL-FREE gate — it is meant to be
      // dropped on any repo, including ones that never adopted oxlint — so that
      // exit is a no-op, not a verdict, and must not turn the check red.
      // Classified on the output sentinel, never the exit code, which cannot
      // tell the two apart (see `isNothingToLint`).
      const skipped = isNothingToLint(`${result.stdout}\n${result.stderr}`);

      // fail-on-nonzero — a lint finding (non-zero exit) turns the check red,
      // carrying the log link, the same way `offload-test` renders a failure.
      //
      // Two non-zero exits that are NOT findings are already excluded by the
      // time we get here: the checkout dir reaped between steps, so `npx` could
      // not even `cd` into it (`sandbox.exec` reclassifies it as a retryable
      // `ExecFailed` — see sandbox-cf.ts `isWorkingDirFailure`), and the
      // nothing-to-lint no-op above. OTHER ways `npx oxlint` can exit non-zero
      // without a genuine finding (an unfetchable version, a malformed
      // `.oxlintrc.json`) still land here, so the wording points at the log
      // rather than asserting violations outright.
      if (input.failOnNonZeroExit && result.exitCode !== 0 && !skipped) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: result.exitCode,
            summaryMd: [
              `\`${command}\` exited \`${result.exitCode}\` — oxlint reported lint problems (or failed to run; see the log).`,
              "",
              `[View full oxlint log ↗](${logUri})`,
            ].join("\n"),
          }),
        );
      }

      return {
        // A no-op is a pass: report 0 so an Action-mode caller gating on
        // `exitCode` stays green, and carry the truth in `skipped`.
        exitCode: skipped ? 0 : result.exitCode,
        durationMs: result.durationMs,
        logUri,
        skipped,
      };
    }),
});
