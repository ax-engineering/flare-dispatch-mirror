// Recipe: AI code review on every PR
//
// A FlareDispatch port of Cloudflare's multi-agent code reviewer —
// https://blog.cloudflare.com/ai-code-review/ — see recipes/ai-code-review for
// how the blog's design maps onto this run.
//
// --- v3: the review runs IN THE WORKER, not a container CLI ------------------
//
// Earlier versions shelled out to a `review-agent` CLI baked into the run's
// container image. That CLI does not exist in the deployed image (every exec
// exited 127), so reviews silently failed. v3 moves the review into the run
// body via `@fractalboxdev/flare-dispatch-review-agent`, which calls a model through the
// `modelGateway` capability — backed by the Cloudflare Workers AI binding
// (`env.AI`) via an AI Gateway. The binding is the auth (Workers AI is
// account-billed), so NO model API key is configured. The ONE container image
// (infra/Dockerfile.sandbox: Node + git + curl) is used only for `git`
// (checkout + diff); every model call happens in the Worker, against a
// CONFIGURABLE backend resolved from CONFIG_KV.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  pr-review.agents         "single" (one generalist reviewer) | "multi" (tier-scaled per-domain personas)  (default "multi")
//   CONFIG_KV  pr-review.backend        "workers-ai" | "anthropic" | "bedrock"  (default workers-ai). A MODEL ROUTE, not an agentic tool — `opencode`/`reasonix` are reserved for the agent tier (specs/09-agentic-review.md), not this one.
//   CONFIG_KV  pr-review.prompt          (optional) REPLACE the reviewer system prompt
//   CONFIG_KV  pr-review.guidelines      (optional) ADDITIVE house rules appended to the reviewer prompt (suppression rubric / conventions / severity calibration)
//   CONFIG_KV  pr-review.workers-ai.model  model id — a bare Workers AI catalog id (e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast, account-billed, no key) OR a `deepseek/`-prefixed hosted reasoner (e.g. deepseek/deepseek-reasoner, BYOK via AI Gateway — the real model)
//   CONFIG_KV  pr-review.workers-ai.mode   "tools" | "json"  (default "tools"; pin "json" for reasoning models — DeepSeek-class models ignore tool-calls)
//   CONFIG_KV  pr-review.<backend>.maxDiffChars  (optional) override the per-backend diff cap — a positive int clamped to [1_000, 1_000_000]. Defaults: workers-ai 60_000, anthropic/bedrock 240_000. Raise it for a big-context Workers AI model (GLM / Kimi). A value above the model's context makes the provider reject with a context-overflow: the engine shrink-retries the diff (halved, visibly truncated), and if it still can't fit the run SKIPS soft (neutral check via `RunSkipped`), never a red failure.
//   CONFIG_KV  pr-review.<backend>.maxTokens  (optional) override the per-backend output-token budget — a positive int clamped to [256, 32_768]. Defaults: workers-ai 8_192, anthropic/bedrock 4_096. A ceiling (non-reasoning models unaffected); raise it if a reasoning model truncates inside <think> before the JSON answer.
//   CONFIG_KV  pr-review.anthropic.model `anthropic/`-prefixed model id (e.g. anthropic/claude-sonnet-4-6) — BYOK via AI Gateway
//   CONFIG_KV  pr-review.anthropic.mode  "tools" | "json"  (default "tools")
//   CONFIG_KV  pr-review.bedrock.model   `bedrock/`-prefixed model id (e.g. bedrock/us.anthropic.claude-opus-4-6-v1) — BYOC via AI Gateway
//   CONFIG_KV  pr-review.bedrock.region  AWS region (default us-east-1)
//   CONFIG_KV  pr-review.bedrock.roleArn IAM role to AssumeRoleWithWebIdentity into — trust policy MUST pin `sub: pr-review:*`
//   CONFIG_KV  pr-review.style           "default" (one detailed section per finding) | "compact" (LGTM-header + 3-col emoji table)
//   CONFIG_KV  pr-review.compact-max     how many findings the `compact` layout lists inline before "…and N more" (positive int, clamp 1..100, default 7; no-op for `default`)
//   CONFIG_KV  pr-review.cooldown-seconds  dispatch throttle window in seconds (positive int, clamp 60..86400, default 3600). Absent → one review per PR per 60 min.
//
// No API key: the Workers AI binding is the auth. A "tools"-mode backend that
// returns no tool calls auto-retries once in "json" mode, so a model that
// silently drops tool-calling still produces a review. A json-mode answer that
// carries no parseable JSON (prose, or a value truncated inside a reasoning
// block) gets ONE blunt "JSON only" repair retry before it counts as failed.
//
// The per-domain fan-out is fault-ISOLATED: one reviewer whose model call fails
// (unparseable output, a transient 429) is dropped to zero findings and flagged
// in the engagement line — the review still ships with the domains that
// succeeded. The run only goes red when EVERY reviewer fails.
//
// --- Per-dispatch overrides (Action mode) -----------------------------------
//
// A dispatch MAY override the CONFIG_KV defaults per call via the run inputs —
// `agents`, `backend`, `modelId`, `region`, `roleArn`, `focusArea`. Absent, the
// CONFIG_KV defaults apply, so the everyday Webhook path is unchanged. This is
// the model-bake-off / per-PR-escalation path the former `multi-agent-review`
// run served: dispatch `backend: "bedrock"`, a `modelId` under test, and a
// `roleArn` to compare a model on a real PR without touching CONFIG_KV.
//
// Mode: Webhook mode (fires on every pull_request push, zero GHA minutes) AND
//       Action mode (a GHA workflow dispatches it with per-call overrides).
// DSL:  see specs/03-dsl.md (uses `config` + `github`).

import { Effect, Schema, Match, Option, Either } from "effect";
import {
  defineRun,
  step,
  sandbox,
  artifact,
  config,
  io,
  github,
  type ReadFileFailed,
  RunSkipped,
  StepFailed,
  type Container,
  type WebhookPayload,
} from "@fractalboxdev/flare-dispatch-core";
import {
  awsAssumeRole,
  isNothingToLint,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import {
  type BackendUnconfigured,
  backendConfigKey,
  capDiff,
  composeSystemPrompt,
  coordinate as engineCoordinate,
  NAMESPACE_DEFAULT,
  REVIEW_SYSTEM_PROMPT_DEFAULT,
  type Finding,
  guidelinesKey,
  type ModelCallFailed,
  namespacedKeys,
  parseBackend,
  resolveBackend,
  reviewDomain,
  riskTier,
  ReviewOutputSchema,
  stripDiffNoise,
  type StructuredOutputInvalid,
  type Tier,
} from "@fractalboxdev/flare-dispatch-review-agent";
import { VERSION_DEFAULT as OXLINT_VERSION_DEFAULT } from "./oxlint";

// Local helper — true if the PR carries the given label.
const hasLabel = (payload: WebhookPayload, name: string): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  payload.pull_request?.labels?.some((l: { name: string }) => l.name === name) ?? false;

// The domain-scoped reviewers, one per concern (blog: "up to seven
// domain-specific agents"). The risk tier selects which subset actually runs.
const FULL_AGENTS = [
  "security",
  "performance",
  "code-quality",
  "documentation",
  "release-management",
  "compliance",
  "agents-md",
] as const;
const LITE_AGENTS = ["security", "code-quality", "performance", "documentation"] as const;
const TRIVIAL_AGENTS = ["code-quality"] as const;

// Agent fan-out mode. `multi` (the default) fans out to the tier-scaled
// per-domain personas above — the historical behaviour. `single` runs ONE
// generalist reviewer covering every concern (the collapsed `multi-agent-review`
// run's single-agent shape, now through the same structured engine). The
// operator picks the mode via `pr-review.agents` CONFIG_KV; a dispatch overrides
// it per call via the `agents` input.
const GENERAL_AGENT = ["general"] as const;
const AGENT_MODES = ["single", "multi"] as const;
type AgentMode = (typeof AGENT_MODES)[number];
const AGENT_MODE_DEFAULT: AgentMode = "multi";

/** Narrow an arbitrary config string to a known agent mode, or the default. */
const parseAgentMode = (raw: string | undefined): AgentMode =>
  AGENT_MODES.includes(raw as AgentMode) ? (raw as AgentMode) : AGENT_MODE_DEFAULT;

/** Config namespace this run's backend + prompt keys live under (`pr-review.*`). */
const NS = NAMESPACE_DEFAULT;

// The run's output. `findings` becomes the check-run annotation set; the rest
// renders in the summary. Imported from the engine package so the run's
// `outputs` schema and the engine's return type are one source of truth. Each
// push re-reviews the full PR diff independently — the current run is
// authoritative (no carry-over from prior executions), so a fixed finding clears.
const ReviewOutput = ReviewOutputSchema;

/** Footer marker on every PR comment this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: pr-review -->";

/**
 * The "view full logs" footer for a PR comment — a markdown link to this
 * execution's log viewer, which (since #137) also lists the reviewed
 * `pr-review.diff` artifact. `undefined` viewer URL (a deploy with no public
 * origin / no log-link key) → empty string, so the comment renders exactly as
 * before. `viewerUrl` is dispatcher-minted (tokened), never model-authored, so
 * it needs no sanitization.
 */
const viewerFooter = (viewerUrl: string | undefined): readonly string[] =>
  viewerUrl === undefined ? [] : ["", `📋 [View full logs & reviewed diff ↗](${viewerUrl})`];

/**
 * Where `prepare-diff` writes the unified diff inside the container. Read back
 * in full via `sandbox.readFile` — `ExecResult.stdout` inlines only a 16KB
 * tail, which silently reviewed a sliver of any sizeable PR.
 */
const DIFF_FILE = "/tmp/pr-review.diff";

// --- Oxc grounding -----------------------------------------------------------
//
// Before the model fans out, run oxlint (the Oxc Rust linter — Vite/VoidZero,
// now inside Cloudflare) on the PR's changed files IN THE SAME container the
// diff was produced in, and prepend its findings to the reviewable text. The
// model then CONFIRMS / EXPANDS deterministic, pre-computed static-analysis
// results (with exact `file:line` anchors) instead of re-deriving lint-level
// issues from the diff alone — cheaper tokens, fewer hallucinated findings,
// citable anchors.
//
// Best-effort by construction: oxlint runs via `npx` (no image change), and ANY
// failure — no lintable files, fetch error, read error — degrades to an empty
// block, so the review proceeds ungrounded and never goes red on this step.

/** Where the oxlint run writes its findings inside the container. */
const OXLINT_FILE = "/tmp/pr-review.oxlint.txt";
/**
 * oxlint version fetched via `npx` for the grounding block — the SAME exact
 * pin the `oxlint` gate runs, so the findings quoted to the reviewer are the
 * findings that decide the check. Tracked the `1.x` major until 2026-08-18,
 * when a minor release moved five rules into `correctness` and changed what
 * every consumer's gate enforced overnight; see `VERSION_DEFAULT` in
 * `runs/oxlint.ts` for the full account.
 */
const OXLINT_VERSION = OXLINT_VERSION_DEFAULT;
/** Cap the changed-file list passed to oxlint (bounds the command line). */
const OXLINT_MAX_FILES = 60;
/** Cap the grounding block prepended to the model context. */
const OXLINT_MAX_CHARS = 8000;
/** Extensions oxlint lints — the changed files worth scanning. */
const LINTABLE_EXT = /\.(?:m?[jt]sx?|cjs)$/;

/**
 * Pull the changed (added/modified) file paths from a unified diff's
 * `+++ b/<path>` headers, keep the oxlint-lintable ones, dedupe, and cap.
 * `/dev/null` targets (deletions) are dropped.
 */
const changedLintableFiles = (diff: string): readonly string[] => {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const target = line.slice(4).trim();
    if (target === "/dev/null") continue;
    const path = target.startsWith("b/") ? target.slice(2) : target;
    if (LINTABLE_EXT.test(path)) files.add(path);
  }
  return [...files].slice(0, OXLINT_MAX_FILES);
};

/**
 * Wrap raw oxlint output in a labelled, capped grounding block — "" when there
 * is nothing to ground with. Empty output is the clean case (oxlint prints
 * nothing when it finds nothing), and `isNothingToLint` catches the other: the
 * changed files were all gitignored / unlintable, so oxlint reports an empty
 * file set. That sentinel is not a finding, and the block labels its contents
 * "authoritative" to the model — so it must never be dressed up as one.
 */
const groundingBlock = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isNothingToLint(trimmed)) return "";
  const body =
    trimmed.length > OXLINT_MAX_CHARS
      ? `${trimmed.slice(0, OXLINT_MAX_CHARS)}\n…(truncated)`
      : trimmed;
  return [
    "## Static analysis — oxlint findings on the changed files",
    "",
    "Deterministic, pre-computed by the Oxc linter. Treat as authoritative:",
    "confirm/expand these, cite their `file:line` anchors, and do NOT re-derive",
    "lint-level issues the linter already reports.",
    "",
    "```",
    body,
    "```",
  ].join("\n");
};

export const prReview = defineRun({
  name: "pr-review",
  version: "3.2.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-review:latest",

  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "ready_for_review"],
      // MUST match Action mode's semantic instanceId — `{run}:{repo_}:{sha12}`
      // (dispatch.ts `semanticInstanceId`) — so a repo that BOTH installs the
      // App (webhook mode) and dispatches from its own CI (Action mode)
      // collapses to ONE review per head SHA at the `create({id})` layer
      // instead of paying two sandbox runs. The PR number adds nothing to the
      // identity: the dispatcher's dedup contract is "same {run, repo, sha} →
      // same execution", and the number still rides in `inputs`.
      idempotencyKey: ({ payload }) =>
        `pr-review:${payload.repository.full_name.replace(/\//g, "_")}:${payload.pull_request.head.sha.slice(0, 12)}`,
      gate: ({ payload }) =>
        (!payload.pull_request.draft || hasLabel(payload, "request-ai-review")) &&
        !hasLabel(payload, "skip-ai-review") &&
        !payload.pull_request.user.login.endsWith("[bot]"),
      inputs: ({ payload }) => ({
        repo: payload.repository.full_name,
        sha: payload.pull_request.head.sha,
        baseSha: payload.pull_request.base.sha,
        pr: payload.pull_request.number,
        installationId: payload.installation.id,
      }),
    },
  ],

  inputs: Schema.Struct({
    repo: Schema.String,
    sha: Schema.String,
    baseSha: Schema.String,
    pr: Schema.Number,
    // Webhook mode maps it from `payload.installation.id`; Action mode omits
    // it. The run threads it to `github.pullReview` to authenticate the comment.
    installationId: Schema.optional(Schema.Number),
    // --- Per-dispatch overrides (Action mode) — all optional. When absent the
    //     CONFIG_KV defaults apply, so the Webhook path is unchanged. These ride
    //     the HMAC-authenticated dispatch (operator-trusted), never the diff. ---
    /** Override `pr-review.agents` — one generalist reviewer vs the persona fan-out. */
    agents: Schema.optional(Schema.Literal("single", "multi")),
    /** Override `pr-review.backend` — pin a backend for this dispatch (e.g. a bake-off). */
    backend: Schema.optional(Schema.String),
    /** Override the resolved backend's model id (e.g. the model under test). */
    modelId: Schema.optional(Schema.String),
    /** Override the bedrock backend's AWS region. */
    region: Schema.optional(Schema.String),
    /** Override the bedrock backend's IAM role ARN to AssumeRoleWithWebIdentity into. */
    roleArn: Schema.optional(Schema.String),
    /** Extra focus line appended to the reviewer system prompt for this dispatch. */
    focusArea: Schema.optional(Schema.String),
  }),

  outputs: ReviewOutput,

  // A PR verdict someone waits on: admitted ahead of batch work.
  limits: { maxDurationSec: 1500, maxConcurrency: FULL_AGENTS.length, admissionClass: "interactive" },

  // At most one review per PR per window, across BOTH dispatch paths
  // (webhook + Action). Default 60 min; override via CONFIG_KV
  // `pr-review.cooldown-seconds`. A rapid push sequence on an active PR
  // collapses to the first dispatch of the window; the skipped pushes answer
  // 202 with the prior execution's id, so CI stays green.
  cooldown: {
    secondsDefault: 3600,
    secondsKey: "pr-review.cooldown-seconds",
    scope: (input) => `pr-${input.pr}`,
  },

  run: (input) =>
    Effect.gen(function* () {
      // This execution's log-viewer URL — links every PR comment (success OR
      // failure) back to the full logs + the reviewed `pr-review.diff` artifact.
      // `Option.none()` on a deploy with no public origin / log-link key, in
      // which case the comment renders link-less, as before.
      const viewerUrl = Option.getOrUndefined(yield* io.viewerUrl);
      // The whole review is wrapped in an error boundary that ALWAYS posts a PR
      // comment — success or failure. `reviewBody` produces the output; the
      // catch arm posts a comment and re-fails so the check reflects what
      // happened. Two failure families (issue #21):
      //   - CAPACITY (`ModelCallFailed` whose reason is one of `SKIP_KINDS`:
      //     `context-overflow`, i.e. every reviewer overflowed the model's
      //     context even after the engine's shrink-retries; or `rate-limited`,
      //     i.e. the AI Gateway refused every reviewer): the review never ran —
      //     post a "skipped" comment and fail `RunSkipped`, which the
      //     dispatcher concludes as a `neutral` check-run, never `failure`.
      //   - everything else: post "could not complete" and re-fail as
      //     `StepFailed`, so the check goes red honestly.
      // The comment post itself is best-effort — a failure to post must not
      // mask the original cause.
      //
      // WHAT NEUTRAL MEANS FOR A MERGE GATE. GitHub counts a `neutral` check as
      // passing for a required status check, so a capacity skip does not block a
      // merge even with branch protection on. That is the intended trade: red
      // must mean "this code has a problem", and neither a diff too big to read
      // nor a busy gateway is that. The cost is real and worth naming — a PR can
      // merge with no review having run, and the only thing that makes that
      // visible is the skip COMMENT, which states outright that no code was
      // reviewed. So `flare-dispatch/pr-review` is a signal, not an enforcement
      // point. An org that wants a hard gate on "a review actually ran" has to
      // build it outside this check; making the capacity arms red instead would
      // buy that gate at the price of a badge that lies about the code.
      return yield* reviewBody(input, viewerUrl).pipe(
        Effect.catchAll((err) =>
          Match.value(err).pipe(
            Match.tag("ModelCallFailed", (e) =>
              isSkipKind(e.reason)
                ? skipReview(input, viewerUrl, e, e.reason)
                : failReview(input, viewerUrl, e),
            ),
            Match.orElse(() => failReview(input, viewerUrl, err)),
          ),
        ),
      );
    }),
});

/** The boundary's red arm: post "could not complete", re-fail as `StepFailed`. */
const failReview = (input: RunInput, viewerUrl: string | undefined, err: unknown) =>
  Effect.gen(function* () {
    const reason = describeError(err);
    // Post inside a step so a CF Workflow instance retry replays from
    // the checkpoint instead of posting a duplicate failure comment.
    yield* step("post-failure-comment", () =>
      postComment(
        input,
        [
          `⚠️ **pr-review could not complete**: ${reason}`,
          ...viewerFooter(viewerUrl),
          "",
          COMMENT_MARKER,
        ].join("\n"),
      ).pipe(
        Effect.catchAll((postErr) =>
          io.log("warn", `pr-review: failure-comment post failed — ${describeError(postErr)}`),
        ),
      ),
    );
    return yield* Effect.fail(new StepFailed({ step: "pr-review", cause: reason }));
  });

/** The conditions under which the review was IMPOSSIBLE rather than bad, and
 *  the two strings each one owes the reader. All are capacity, not a verdict on
 *  the code — see `skipReview`.
 *
 *  `reason` is the check-run summary AND the `RunSkipped.reason`, so both
 *  surfaces tell the same story. Each names the CAUSE, not the symptom, and
 *  says outright that no review ran: a reader must not be left wondering
 *  whether the code was examined and passed. "Capacity" alone would leave
 *  exactly that ambiguity. `advice` is the operator-facing "what to do".
 *
 *  ONE record rather than two parallel ones, keyed by the error schema's own
 *  reason union: the `satisfies` rejects a key that is not a real
 *  `ModelCallFailed.reason`, and both the type and the boundary predicate below
 *  derive from it, so a third capacity kind is one edit that cannot be half
 *  applied. */
const SKIP = {
  "context-overflow": {
    reason:
      "the PR diff exceeds the model's context window even after truncation, so the review could not run",
    advice:
      "To review PRs this size, configure a larger-context model " +
      "(`pr-review.<backend>.model`) or lower `pr-review.<backend>.maxDiffChars`.",
  },
  "rate-limited": {
    reason: "the AI Gateway rate-limited every reviewer, so no code was reviewed",
    advice:
      "This is a shared-capacity condition, not a code problem: every reviewer " +
      "for this PR was refused by the gateway, most often when several PRs are " +
      "reviewed at once and the per-window quota is exhausted. A re-dispatch " +
      "reviews the same commit, but only after THIS run's cooldown has elapsed " +
      "(`pr-review.cooldown-seconds`, default 60 min, scoped to the PR) — an " +
      "earlier one is answered with this execution's id and does not review " +
      "again. Making it rare is a capacity decision (gateway rate limit, " +
      "reviewer fan-out, or backend).",
  },
} as const satisfies Partial<
  Record<ModelCallFailed["reason"], { readonly reason: string; readonly advice: string }>
>;

type SkipKind = keyof typeof SKIP;

/** Does this `ModelCallFailed.reason` mean the review could not be attempted? */
const isSkipKind = (reason: ModelCallFailed["reason"]): reason is SkipKind => reason in SKIP;

/** Is this reviewer failure a CAPACITY condition — one the boundary would turn
 *  into a neutral skip rather than a red verdict?
 *
 *  Every skip kind, not just `rate-limited`: the all-fail cause preference has
 *  to de-prioritise anything the boundary would render neutral, or a single
 *  capacity failure among six real ones still launders the run to neutral.
 *
 *  `Match.exhaustive` over `reviewDomain`'s error union rather than a `._tag`
 *  test, so adding a third failure type to that union is a compile error right
 *  here — whoever adds it has to say whether it counts as capacity. */
const isCapacityFailure = Match.type<ModelCallFailed | StructuredOutputInvalid>().pipe(
  Match.tag("ModelCallFailed", (e) => isSkipKind(e.reason)),
  Match.tag("StructuredOutputInvalid", () => false),
  Match.exhaustive,
);

/** The boundary's neutral arm: the review was IMPOSSIBLE for capacity reasons —
 *  either the diff still exceeded the model's context after the engine's
 *  shrink-retries, or the AI Gateway rate-limited EVERY reviewer (`SKIP_KINDS`).
 *  Post a "skipped" comment and fail `RunSkipped` so the dispatcher concludes
 *  the check `neutral`, not red.
 *
 *  Neither kind is a statement about the code, so neither may render red; what
 *  keeps the outcome honest instead is the comment, which says outright that no
 *  code was reviewed. See the boundary in `run` for why `neutral` also means
 *  this check does not gate a merge. */
const skipReview = (
  input: RunInput,
  viewerUrl: string | undefined,
  err: ModelCallFailed,
  kind: SkipKind,
) =>
  Effect.gen(function* () {
    yield* step("post-skip-comment", () =>
      postComment(
        input,
        [
          `⊘ **pr-review skipped**: ${SKIP[kind].reason}.`,
          "",
          `A capacity limit, not a code problem (${describeError(err)}). ` +
            "The check concludes `neutral`. " +
            SKIP[kind].advice,
          ...viewerFooter(viewerUrl),
          "",
          COMMENT_MARKER,
        ].join("\n"),
      ).pipe(
        Effect.catchAll((postErr) =>
          io.log("warn", `pr-review: skip-comment post failed — ${describeError(postErr)}`),
        ),
      ),
    );
    return yield* Effect.fail(new RunSkipped({ reason: SKIP[kind].reason }));
  });

// ---------------------------------------------------------------------------
// The review proper.

const reviewBody = (input: RunInput, viewerUrl?: string) =>
  Effect.gen(function* () {
    // 1. Resolve the configurable backend (model id + output mode + diff cap)
    //    from CONFIG_KV, with any per-dispatch input overrides layered on top —
    //    FIRST, before paying for a container, so a misconfigured backend fails
    //    fast → the error boundary posts a PR comment naming the missing key. No
    //    API key — the model is called through the `modelGateway` capability
    //    (Workers AI binding via an AI Gateway), which the runtime provides
    //    ambiently.
    const resolved = yield* step("resolve-backend", () => resolveEffectiveBackend(input));

    // 2. Check out the PR head. `git` is in the image; no dependency install.
    const { container, dir: repoDir } = yield* step("checkout", () =>
      workspace({ repo: input.repo, sha: input.sha }),
    );

    // 3. Build the reviewable diff with plain `git` (no `review-agent` CLI).
    //    A non-zero exit FAILS the step (honest red check) — see `execOrFail`.
    //
    //    The diff is written to a FILE and read back with `sandbox.readFile`
    //    — NOT taken from `ExecResult.stdout`, which inlines only a bounded
    //    16KB tail (the rest streams to R2). Reading stdout silently reviewed
    //    just the last sliver of any sizeable PR: the risk tier under-counted
    //    (a huge PR classified `lite`/`trivial`), sensitive paths escaped the
    //    `full` escalation, and the reviewers "found nothing" because they
    //    never saw the change.
    //
    //    Noise-strip + backend-sized cap happen INSIDE the step so the value
    //    the Workflow checkpoints is bounded by `maxDiffChars`, never the raw
    //    multi-MB diff. One global cap sized for a frontier model would
    //    overflow a catalog model's context invisibly (the model goes
    //    needle-blind and "finds nothing") — hence the RESOLVED backend's cap.
    //
    //    THREE-dot diff (`base...head`), never two-dot: `baseSha` is the base
    //    branch TIP at event time (`pull_request.base.sha`), not the fork
    //    point. A two-dot endpoint diff on any PR behind its base reviewed
    //    `base-tip → head`, presenting everything merged to the base since
    //    the fork as DELETIONS — reviewers flagged phantom removals of files
    //    the PR never touched. Three-dot diffs from `merge-base(base, head)`,
    //    matching the PR diff GitHub itself renders.
    const diff = yield* step("prepare-diff", () =>
      execOrFail({
        container,
        cwd: repoDir,
        command: [
          "git",
          "diff",
          "--unified=3",
          `--output=${DIFF_FILE}`,
          `${input.baseSha}...${input.sha}`,
        ],
      }).pipe(
        Effect.andThen(sandbox.readFile({ container, path: DIFF_FILE })),
        Effect.map((raw) => capDiff(stripDiffNoise(raw), resolved.maxDiffChars)),
      ),
    );

    // 3b. Persist the FULL (uncapped) diff as an artifact so the log viewer can
    //     surface it and a reviewer can read exactly what was reviewed. The
    //     checkpointed `diff` value is capped for the model's context; the file
    //     on disk is the whole thing. Best-effort: a `git diff --output=<file>`
    //     emits no stdout, so without this the run leaves no visible record of
    //     the diff. A capture failure must never fail the review — swallow it.
    yield* step("upload-diff", () =>
      artifact.upload({
        name: "pr-review.diff",
        path: DIFF_FILE,
        container,
        contentType: "text/plain; charset=utf-8",
      }),
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`upload-diff failed (non-fatal): ${cause}`),
      ),
    );

    // 4. Risk tier — a pure heuristic on diff size + touched paths (no model
    //    call). The tier is always classified (it sizes the diff cap + renders
    //    in the comment); the agent MODE decides whether it also scales the
    //    persona fan-out.
    const tier = yield* step("classify-risk", () => riskTier({ diff }));

    // 4b. Agent fan-out mode — `single` (one generalist reviewer) vs `multi`
    //     (the tier-scaled per-domain personas). Input override > CONFIG_KV >
    //     default. The plan's agent set follows from the mode.
    const agentMode: AgentMode =
      input.agents ??
      parseAgentMode(yield* step("resolve-agents", () => config.get("pr-review.agents")));
    const plan = planForMode(agentMode, tier);

    // 5. The reviewer system prompt — layered base → guidelines → focus,
    //    composed here (not threaded through the engine) so `focusArea` rides
    //    the trusted dispatch input, never the attacker-controllable diff. The
    //    model's OUTPUT is still sanitized before it renders in the public
    //    comment regardless.
    //      - `pr-review.prompt`     REPLACES the base reviewer instruction.
    //      - `pr-review.guidelines` is ADDITIVE — appended on top as authoritative
    //        house rules (a suppression rubric, project conventions, severity
    //        calibration), so an operator can shape the review without forking
    //        the maintained default prompt.
    const promptOverride = yield* step("resolve-prompt", () => config.get("pr-review.prompt"));
    const guidelines = yield* step("resolve-guidelines", () => config.get(guidelinesKey(NS)));
    const systemPrompt = composeSystemPrompt({
      base: promptOverride ?? REVIEW_SYSTEM_PROMPT_DEFAULT,
      ...(guidelines !== undefined ? { guidelines } : {}),
      ...(input.focusArea !== undefined ? { focus: input.focusArea } : {}),
    });

    // 5b. Comment style preset — operator picks the comment layout. Both
    //     presets are hard-coded server-side (so model-authored text can't
    //     inject layout). See `parseStyle` + `renderReviewComment`.
    const style = parseStyle(yield* step("resolve-style", () => config.get("pr-review.style")));

    // 5b-ii. How many findings the `compact` layout lists inline before the
    //        "…and N more" overflow line. Operator-tunable so the leaderboard
    //        layout can show more (or fewer) without a code change; clamps to a
    //        sane range, defaults to 7. No-op for the `default` layout, which
    //        uses its own MAX_RENDERED_FINDINGS.
    const compactMax = parseCompactMax(
      yield* step("resolve-compact-max", () => config.get("pr-review.compact-max")),
    );

    // 5c. When the resolved backend is `bedrock`, mint short-lived AWS creds via
    //     OIDC federation — the modelGateway Bedrock route SigV4-signs each call
    //     with these. The role's trust policy SHOULD pin `sub: pr-review:*` so
    //     a leaked HMAC alone can't assume the role; `awsAssumeRole`'s default
    //     subject is `<run>:<execution-id>`, which matches that pattern. Other
    //     backends skip this step entirely.
    const bedrockCreds =
      resolved.backend === "bedrock" &&
      resolved.roleArn !== undefined &&
      resolved.region !== undefined
        ? yield* step("assume-bedrock-role", () =>
            awsAssumeRole({
              roleArn: resolved.roleArn as string,
              region: resolved.region as string,
              sessionName: `pr-review-${input.sha.slice(0, 12)}`,
            }),
          )
        : undefined;
    const awsCreds =
      bedrockCreds !== undefined && resolved.region !== undefined
        ? {
            accessKeyId: bedrockCreds.accessKeyId,
            secretAccessKey: bedrockCreds.secretAccessKey,
            sessionToken: bedrockCreds.sessionToken,
            region: resolved.region,
          }
        : undefined;

    // 5d. Oxc grounding — run oxlint on the PR's changed files in the checkout
    //     container and prepend its findings to the reviewable text. Best-
    //     effort: any failure (no lintable files, npx fetch, read) degrades to
    //     the ungrounded diff via `catchAllCause`, so the review never goes red
    //     on this step. `riskTier` above used the RAW diff (size heuristic), so
    //     the grounding block doesn't perturb tier classification.
    const oxlintBlock = yield* step("oxlint-scan", () =>
      Effect.gen(function* () {
        const files = changedLintableFiles(diff);
        if (files.length === 0) return "";
        // Non-zero exit (oxlint found issues) is a NORMAL ExecResult, not a
        // failure; redirect both streams to a file read back in full (the
        // 16KB stdout tail would truncate a busy lint report).
        yield* sandbox.exec({
          container,
          cwd: repoDir,
          command: `npx --yes oxlint@${OXLINT_VERSION} ${files.join(" ")} > ${OXLINT_FILE} 2>&1`,
        });
        const out = yield* sandbox.readFile({ container, path: OXLINT_FILE });
        return groundingBlock(out);
      }),
    ).pipe(Effect.catchAllCause(() => Effect.succeed("")));
    const groundedDiff = oxlintBlock.length > 0 ? `${oxlintBlock}\n\n${diff}` : diff;

    // 6. Fan out one reviewer per domain, IN-WORKER, in parallel — only the
    //    agents this tier calls for. Each calls the model via the `modelGateway`
    //    capability (provided by the runtime, like `config`/`sandbox`); findings
    //    are Schema-validated tool-call / json output. The reviewers see the
    //    GROUNDED diff (oxlint findings prepended), not the raw diff.
    //
    //    FAULT-ISOLATED fan-out: each reviewer is wrapped in `Effect.either`, so
    //    one domain whose model call fails — unparseable output
    //    (`StructuredOutputInvalid`), a transient 429 under the concurrent
    //    fan-out (`ModelCallFailed`) — is dropped to zero findings and flagged
    //    `errored` in the engagement line, rather than aborting the whole review.
    //    The review still ships with every domain that DID succeed — resilience
    //    is the point of the multi-agent design. ONLY when EVERY reviewer fails
    //    do we re-raise (the typed cause), so the boundary posts an honest "could
    //    not complete" for a systemic fault (misconfigured backend, wrong
    //    model/mode, gateway down) instead of masking it as an empty review.
    const reviewed = yield* step(
      "review",
      () =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach(
            plan.agents,
            (agent) =>
              reviewDomain({
                agent,
                diff: groundedDiff,
                tier: plan.tier,
                model: resolved.model,
                backend: resolved.backend,
                mode: resolved.mode,
                maxTokens: resolved.maxTokens,
                systemPrompt,
                ...(awsCreds !== undefined ? { aws: awsCreds } : {}),
              }).pipe(Effect.either),
            { concurrency: plan.agents.length },
          );

          // Log each failed domain's cause (the per-reviewer error is otherwise
          // swallowed by the tolerance below) for operator diagnosis in the logs.
          for (let i = 0; i < plan.agents.length; i++) {
            const r = results[i];
            if (r !== undefined && Either.isLeft(r)) {
              yield* io.log(
                "warn",
                `pr-review: reviewer "${plan.agents[i]}" failed — ${describeError(r.left)}`,
              );
            }
          }

          // Every reviewer failed → no partial review to salvage; re-raise a
          // cause (typed) so the error boundary names it precisely.
          //
          // WHICH cause matters, because the boundary renders a CAPACITY cause
          // as a neutral skip. Raising the *first* left would let one capacity
          // failure mask six that failed for real reasons — a red run laundered
          // into "the gateway was busy". So prefer any cause the boundary would
          // render RED, and fall back to a capacity one only when every reviewer
          // hit capacity, which is the one case where nothing was reviewed for a
          // reason that says nothing about the code.
          //
          // The preference spans every `SKIP_KIND`, not just `rate-limited`:
          // de-prioritising only the rate limit would leave the identical hole
          // one door along — a lone `context-overflow` among five real failures
          // would still conclude neutral.
          const lefts = results.filter(Either.isLeft).map((l) => l.left);
          if (lefts.length > 0 && lefts.length === results.length) {
            const hardFailure = lefts.find((e) => !isCapacityFailure(e));
            return yield* Effect.fail(hardFailure ?? lefts[0]!);
          }

          // Findings from the domains that succeeded; failed domains contribute
          // none. Per-domain counts (or an `errored` flag) render in the comment so
          // an all-empty review is visibly "N reviewers each reported 0", and a
          // degraded review is visibly "this domain errored" — never silently
          // indistinguishable from "found nothing".
          const findings: ReadonlyArray<Finding> = results.flatMap((r) =>
            Either.isRight(r) ? r.right : [],
          );
          const domainCounts: ReadonlyArray<DomainCount> = plan.agents.map((agent, i) => {
            const r = results[i];
            return r !== undefined && Either.isRight(r)
              ? { agent, count: r.right.length }
              : { agent, count: 0, errored: true };
          });
          return { findings, domainCounts };
        }),
      // Cap the per-step retry. CF Workflows' default is `limit: 5` (up to 6
      // attempts), and a step retry REPLAYS the whole fan-out. This step throws
      // ONLY when EVERY reviewer failed — an all-fail is systemic: a 429 storm
      // from the concurrent burst (`concurrency: plan.agents.length`) hitting a
      // low-per-model-rate-limit model, a backend down, or a wrong model/mode.
      // The per-domain calls are NOT individually retried on 429, so replaying
      // the 7-way burst 5 more times just re-throttles the same model and
      // re-issues every call. One retry (after the backoff, by which the
      // per-minute rate window may have rolled over) keeps recovery for a
      // genuine transient while bounding the worst case from ×6 attempts to ×2.
      { retries: 1 },
    );
    const allFindings: ReadonlyArray<Finding> = reviewed.findings;
    const domainCounts: ReadonlyArray<DomainCount> = reviewed.domainCounts;

    // 7. Coordinate — PURE deterministic assembly (dedup + counts + verdict) over
    //    THIS run's findings. No model call; the current run is authoritative, so
    //    a fixed finding clears. `tier` is stitched in from the plan.
    const coordinated = yield* step("coordinate", () =>
      engineCoordinate({ findings: allFindings }),
    );
    const output = { ...coordinated, tier: plan.tier };

    // 8. Post the visible top-level PR review comment (the findings additionally
    //    land as check-run annotations via the run output). Best-effort — a
    //    comment failure must not turn a green review red.
    yield* step("post-comment", () =>
      postComment(
        input,
        renderReviewComment(input, output, domainCounts, style, viewerUrl, compactMax),
      ).pipe(
        Effect.catchAll((e) =>
          io.log("warn", `pr-review: posting PR comment failed — ${describeError(e)}`),
        ),
      ),
    );

    return output;
  });

// ---------------------------------------------------------------------------
// Helpers.

type RunInput = {
  readonly repo: string;
  readonly sha: string;
  readonly baseSha: string;
  readonly pr: number;
  readonly installationId?: number;
  // Per-dispatch overrides (Action mode) — see the `inputs` schema.
  readonly agents?: AgentMode;
  readonly backend?: string;
  readonly modelId?: string;
  readonly region?: string;
  readonly roleArn?: string;
  readonly focusArea?: string;
};

type Plan = {
  readonly tier: Tier;
  readonly agents: readonly string[];
};

/** Map the risk tier to its agent set. (The model is resolved from the backend
 *  config, not the tier — see `resolveBackend`.) */
const planForTier = (tier: Tier): Plan =>
  Match.value(tier).pipe(
    Match.when("trivial", () => ({ tier: "trivial" as const, agents: TRIVIAL_AGENTS })),
    Match.when("lite", () => ({ tier: "lite" as const, agents: LITE_AGENTS })),
    Match.when("full", () => ({ tier: "full" as const, agents: FULL_AGENTS })),
    Match.exhaustive,
  );

/** Map the resolved agent mode + risk tier to the reviewer plan. `single` runs
 *  ONE generalist reviewer (the tier still renders in the comment); `multi` runs
 *  the tier-scaled per-domain personas. */
const planForMode = (mode: AgentMode, tier: Tier): Plan =>
  mode === "single" ? { tier, agents: GENERAL_AGENT } : planForTier(tier);

/**
 * Resolve the active backend, layering per-dispatch input overrides over
 * CONFIG_KV. An override-aware `getConfig` shim feeds the engine's
 * `resolveBackend` the input values where present — so a single dispatch can
 * fully specify a backend (e.g. a Bedrock model bake-off: `backend: "bedrock"`,
 * `modelId`, `roleArn`, `region`) with NO CONFIG_KV keys set, while an everyday
 * webhook review with no overrides resolves exactly as before. The shim only
 * shadows the keys an override targets; everything else still reads CONFIG_KV.
 */
const resolveEffectiveBackend = (input: RunInput) =>
  Effect.gen(function* () {
    // The effective backend names which `<backend>.*` keys an override targets.
    const backend = parseBackend(input.backend ?? (yield* config.get(backendConfigKey(NS))));
    const keys = namespacedKeys(NS)[backend];
    const overrides = new Map<string, string>();
    if (input.backend !== undefined) overrides.set(backendConfigKey(NS), input.backend);
    if (input.modelId !== undefined) overrides.set(keys.modelKey, input.modelId);
    if (input.region !== undefined && keys.regionKey !== undefined)
      overrides.set(keys.regionKey, input.region);
    if (input.roleArn !== undefined && keys.roleArnKey !== undefined)
      overrides.set(keys.roleArnKey, input.roleArn);
    return yield* resolveBackend(
      (key) =>
        overrides.has(key)
          ? Effect.succeed<string | undefined>(overrides.get(key))
          : config.get(key),
      { namespace: NS },
    );
  });

/**
 * Run a container command and FAIL the Effect when it exits non-zero. The core
 * `sandbox.exec` deliberately surfaces a non-zero exit as a normal `ExecResult`
 * (a failing test is data, not an error) — but for `pr-review`'s git steps a
 * non-zero exit IS a real failure that must turn the check red, so we lift it
 * into the typed error channel here (rather than mutating the shared
 * `sandbox.exec`, which other runs rely on).
 */
const execOrFail = (opts: {
  container: Container;
  cwd: string;
  command: readonly string[];
  timeoutSec?: number;
}) =>
  sandbox.exec(opts).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new ExecNonZero({
              command: opts.command.join(" "),
              exitCode: result.exitCode,
              stderrTail: result.stderr.slice(-2000),
            }),
          ),
    ),
  );

/** A container command that ran to completion but exited non-zero. */
class ExecNonZero extends Schema.TaggedError<ExecNonZero>()("ExecNonZero", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderrTail: Schema.String,
}) {}

/** Post a top-level PR review comment via the `github` capability. */
const postComment = (input: RunInput, body: string) =>
  github.pullReview({
    repo: input.repo,
    pr: input.pr,
    sha: input.sha,
    body,
    ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
  });

/** The tagged errors the review boundary knows how to describe precisely;
 *  anything else (e.g. `StepFailed`, a core capability error) falls to the
 *  `Match.orElse` arm. */
type DescribableError =
  | BackendUnconfigured
  | ModelCallFailed
  | StructuredOutputInvalid
  | ExecNonZero
  | ReadFileFailed;

/** Human-readable one-liner for any error the boundary catches. */
const describeError = (err: unknown): string =>
  Match.value(err as DescribableError).pipe(
    Match.tag(
      "BackendUnconfigured",
      (e) => `backend "${e.backend}" is misconfigured — set ${e.missing}`,
    ),
    Match.tag("ModelCallFailed", (e) => `model call failed (${e.reason}): ${e.message}`),
    Match.tag(
      "StructuredOutputInvalid",
      (e) =>
        `model returned unparseable ${e.surface} output (${e.reason}); the backend may need \`mode: "json"\` or a different model` +
        // Surface a short, SANITIZED excerpt of the RAW model text. It is
        // captured on the error but was previously dropped here, so the only
        // record of what the model actually returned lived in the (auth-gated)
        // step logs — which is exactly why an `empty` (the model's answer
        // silently dropped at the binding boundary) took so long to diagnose.
        // `sanitizeModelText` defangs it; the verdict never derives from it.
        (e.excerpt.trim() !== "" ? ` — model returned: "${sanitizeModelText(e.excerpt)}"` : ""),
    ),
    Match.tag("ExecNonZero", (e) => `\`${e.command}\` exited ${e.exitCode}`),
    Match.tag("ReadFileFailed", (e) => `reading the diff file \`${e.path}\` failed: ${e.message}`),
    Match.orElse(() => (err instanceof Error ? err.message : JSON.stringify(err))),
  );

/**
 * Neutralize model-authored text before it renders in the public PR comment.
 * The diff is attacker-controllable on a hostile PR and feeds the model, so a
 * finding's `title`/`message`/`path` could carry `@mention` pings, raw HTML, or
 * code-fence/backtick break-outs. Collapse to one line, drop angle brackets,
 * defang `@` and backticks, and bound the length. (Control flow is already safe
 * — the verdict derives only from the schema-constrained `level`.)
 */
const SANITIZE_MAX = 500;
/**
 * Cap for a finding's `message` in the detailed layout. The schema already
 * bounds `message` at 2 000 chars, but every field shared the title-sized 500,
 * which cut the body of a finding off mid-word — "…since neither can starve"
 * with no marker, reading as a model that failed to finish its sentence rather
 * than as text the renderer clipped. Titles, paths, and table cells keep 500.
 */
const SANITIZE_MAX_MESSAGE = 2_000;
// U+200B zero-width space — inserted after `@` it breaks GitHub's @mention
// autolink without visibly altering the text. Built from a code point so the
// source stays ASCII-only.
const ZWSP = String.fromCharCode(0x200b);
/**
 * Clip at a word boundary and mark the cut with an ellipsis, so truncated text
 * reads as truncated. Falls back to a hard cut when the tail has no space near
 * the limit (a long URL, a minified line).
 */
const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
const sanitizeModelText = (s: string, max: number = SANITIZE_MAX): string =>
  clip(
    s
      .replace(/[\r\n]+/g, " ")
      .replace(/[<>]/g, "")
      .replace(/`/g, "'")
      // Defuse markdown link/image syntax `[text](url)` / `![](url)`. Both
      // require the square brackets, so stripping `[` and `]` neutralises a
      // disguised link (a leaked-token phishing anchor) AND an auto-loading
      // image beacon (a zero-click tracking pixel) — model text is steerable by
      // a hostile fork PR's diff, and this text is posted under the App's
      // identity. A bare URL survives as visible, un-disguised text (GitHub
      // autolinks it, but the destination is no longer hidden behind anchor
      // text).
      .replace(/[[\]]/g, "")
      .replace(/@(?=[\w-])/g, `@${ZWSP}`),
    max,
  );

/** One domain reviewer's engagement — how many findings it reported, or
 *  `errored: true` when its model call failed and it was skipped (count 0). */
type DomainCount = {
  readonly agent: string;
  readonly count: number;
  readonly errored?: boolean;
};

/** How many findings render in the comment; the rest land as check annotations. */
const MAX_RENDERED_FINDINGS = 25;

/** Severity → icon + label, shared by the summary table and per-finding headings.
 *  Labels mirror the header's count names (critical / warnings / suggestions). */
const severityBadge = (level: Finding["level"]): string =>
  Match.value(level).pipe(
    Match.when("failure", () => "🛑 Critical"),
    Match.when("warning", () => "⚠️ Warning"),
    Match.when("notice", () => "💡 Suggestion"),
    Match.exhaustive,
  );

/**
 * GitHub blob URL for a finding — `https://github.com/<repo>/blob/<sha>/<path>#L<n>`.
 * `repo`/`sha` come from the trusted webhook input; `path` is model-authored, so
 * each segment is sanitized then URL-encoded (plus manual paren-encoding —
 * `encodeURIComponent` leaves `()` alone, and a bare `)` would terminate the
 * markdown link). The line fragment is dropped when the model's line numbers
 * are nonsense (≤ 0), leaving a plain file link.
 */
const findingUrl = (repo: string, sha: string, f: Finding): string => {
  const encodedPath = sanitizeModelText(f.path)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  const start = Math.floor(f.startLine);
  const end = Math.floor(f.endLine);
  const fragment = start > 0 ? (end > start ? `#L${start}-L${end}` : `#L${start}`) : "";
  return `https://github.com/${repo}/blob/${sha}/${encodedPath}${fragment}`;
};

/** `path:line` display text for a finding's location. Square brackets are
 *  stripped on top of `sanitizeModelText` — the text renders inside `[…](url)`
 *  link syntax, where a `]` would break out of the link. */
const findingLoc = (f: Finding): string => {
  const path = sanitizeModelText(f.path).replace(/[[\]]/g, "");
  return f.startLine === f.endLine
    ? `${path}:${f.startLine}`
    : `${path}:${f.startLine}-${f.endLine}`;
};

/** Sanitized text safe inside a markdown table cell — an unescaped `|` would
 *  split the row. */
const tableCell = (s: string): string => sanitizeModelText(s).replace(/\|/g, "\\|");

/** Comment style preset — operator selects the layout via `pr-review.style`
 *  CONFIG_KV. Hard-coded presets only; never an arbitrary template (model-
 *  authored text would otherwise be able to inject layout). */
const STYLES = ["default", "compact"] as const;
type Style = (typeof STYLES)[number];
const STYLE_DEFAULT: Style = "default";

/** Narrow an arbitrary config string to a known style, or fall back to default. */
const parseStyle = (raw: string | undefined): Style =>
  STYLES.includes(raw as Style) ? (raw as Style) : STYLE_DEFAULT;

/** Default for how many findings the `compact` style lists (most-critical
 *  first) when `pr-review.compact-max` is unset. The full set is still emitted
 *  as check-run annotations regardless of style; this only bounds how many
 *  appear inline in the PR comment before the "…and N more" overflow line.
 *  Mirrors typical "leaderboard" PR-review bots (7 most-critical first). */
const COMPACT_MAX_LISTED_DEFAULT = 7;

/** Upper clamp on the operator-configured compact cap — a comment listing
 *  hundreds of findings inline would blow past sensible PR-comment length and
 *  GitHub's body limit; the overflow → check-run annotations is the relief
 *  valve. 100 is well above any real review. */
const COMPACT_MAX_LISTED_CLAMP = 100;

/** Parse the `pr-review.compact-max` config (how many findings the `compact`
 *  layout lists inline). Accepts a positive integer string; clamps to
 *  1..{@link COMPACT_MAX_LISTED_CLAMP}; falls back to
 *  {@link COMPACT_MAX_LISTED_DEFAULT} for unset / non-numeric / ≤0 values, so a
 *  typo never silently drops the comment to zero rows. */
const parseCompactMax = (raw: string | undefined): number => {
  if (raw === undefined) return COMPACT_MAX_LISTED_DEFAULT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n <= 0) return COMPACT_MAX_LISTED_DEFAULT;
  return Math.min(n, COMPACT_MAX_LISTED_CLAMP);
};

/** Render the consolidated review as a markdown PR comment. `style` picks the
 *  layout: `default` is the verbose verdict-table for power users; `compact` is
 *  the lean leaderboard-bot format ("`## ✅ LGTM`" + 3-col emoji table). */
const renderReviewComment = (
  input: Pick<RunInput, "repo" | "sha">,
  output: Schema.Schema.Type<typeof ReviewOutput>,
  domainCounts: ReadonlyArray<DomainCount>,
  style: Style = STYLE_DEFAULT,
  viewerUrl?: string,
  compactMax: number = COMPACT_MAX_LISTED_DEFAULT,
): string =>
  Match.value(style).pipe(
    Match.when("compact", () => renderCompact(input, output, viewerUrl, compactMax)),
    Match.when("default", () => renderDefault(input, output, domainCounts, viewerUrl)),
    Match.exhaustive,
  );

/** Verbose layout: one section per finding + the per-domain engagement line.
 *  Full reviewer transparency — the default.
 *
 *  There is deliberately NO summary table above the sections. It listed the
 *  severity, title, and location of every finding, and each section below then
 *  repeated all three — so a 14-finding review rendered 28 times and the reader
 *  scrolled past a table that carried nothing the sections didn't. `compact` is
 *  the layout for operators who want a table; it renders each finding once. */
const renderDefault = (
  input: Pick<RunInput, "repo" | "sha">,
  output: Schema.Schema.Type<typeof ReviewOutput>,
  domainCounts: ReadonlyArray<DomainCount>,
  viewerUrl?: string,
): string => {
  const verdictBadge = Match.value(output.verdict).pipe(
    Match.when("approve", () => "✅ Approve"),
    Match.when("comment", () => "💬 Comment"),
    Match.when("request-changes", () => "🛑 Request changes"),
    Match.exhaustive,
  );

  const header = [
    `### AI code review — ${verdictBadge}`,
    "",
    `Risk tier: \`${output.tier}\` · ${output.critical} critical · ${output.warnings} warnings · ${output.suggestions} suggestions`,
    "",
    // Engagement line: every domain that ran, with its finding count — the
    // counts may exceed the deduped totals above. A domain whose model call
    // failed (and was skipped) shows `⚠️` instead of a count, so a degraded
    // review is visibly partial rather than silently under-reporting.
    `Reviewers: ${domainCounts.map((d) => (d.errored === true ? `${d.agent} ⚠️` : `${d.agent} ${d.count}`)).join(" · ")}`,
  ];

  const rendered = output.findings.slice(0, MAX_RENDERED_FINDINGS);

  const details = rendered.flatMap((f, i) => [
    "",
    `#### ${i + 1}. ${severityBadge(f.level)} — ${sanitizeModelText(f.title)}`,
    "",
    `📍 [${findingLoc(f)}](${findingUrl(input.repo, input.sha, f)})`,
    "",
    sanitizeModelText(f.message, SANITIZE_MAX_MESSAGE),
  ]);

  const findingsBlock =
    output.findings.length === 0
      ? ["", "_No findings._"]
      : [
          ...details,
          ...(output.findings.length > MAX_RENDERED_FINDINGS
            ? [
                "",
                `_…and ${output.findings.length - MAX_RENDERED_FINDINGS} more (see check annotations)._`,
              ]
            : []),
        ];

  return [...header, ...findingsBlock, ...viewerFooter(viewerUrl), "", COMMENT_MARKER].join("\n");
};

/** Compact "leaderboard-bot" layout — verdict header (`## ✅ LGTM` /
 *  `⚠️ Minor Issues` / `🚫 Changes Requested`) + 3-col emoji table, max 7 rows.
 *  Built to match the format teams already get from in-house reviewers like
 *  opencode-agent so a FlareDispatch comment lands without a layout cliff. */
const renderCompact = (
  input: Pick<RunInput, "repo" | "sha">,
  output: Schema.Schema.Type<typeof ReviewOutput>,
  viewerUrl?: string,
  compactMax: number = COMPACT_MAX_LISTED_DEFAULT,
): string => {
  const verdictHeader = Match.value(output.verdict).pipe(
    Match.when("approve", () => "## ✅ LGTM"),
    Match.when("comment", () => "## ⚠️ Minor Issues"),
    Match.when("request-changes", () => "## 🚫 Changes Requested"),
    Match.exhaustive,
  );

  if (output.findings.length === 0) {
    return [
      verdictHeader,
      "",
      "No issues found.",
      ...viewerFooter(viewerUrl),
      "",
      COMMENT_MARKER,
    ].join("\n");
  }

  const compactSeverity = (level: Finding["level"]): string =>
    Match.value(level).pipe(
      Match.when("failure", () => "🔴"),
      Match.when("warning", () => "🟡"),
      Match.when("notice", () => "🔵"),
      Match.exhaustive,
    );

  const rendered = output.findings.slice(0, compactMax);
  const overflow = output.findings.length - rendered.length;

  return [
    verdictHeader,
    "",
    "| Severity | Location | Issue |",
    "| --- | --- | --- |",
    ...rendered.map(
      (f) =>
        `| ${compactSeverity(f.level)} | [${tableCell(findingLoc(f))}](${findingUrl(input.repo, input.sha, f)}) | ${tableCell(f.message)} |`,
    ),
    ...(overflow > 0 ? ["", `_…and ${overflow} more (see check annotations)._`] : []),
    ...viewerFooter(viewerUrl),
    "",
    COMMENT_MARKER,
  ].join("\n");
};
