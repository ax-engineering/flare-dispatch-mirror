// @fractalboxdev/flare-dispatch-runtime-cf — deferred V0 capability Layers.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeLive`
// must supply a Layer for every Tag — even the ones a given deploy can't back.
// Per specs/pm/plan.md § 1 ("All other DSL surface stubbed to `Effect.die`")
// an unbacked capability fails loudly rather than silently mis-behaving.
//
// --- A `die` belongs in a deferred Layer, and never in a live one ------------
//
// A dying stub is honest HERE and lethal in a live Layer, and the difference is
// which question the Layer's selection already answered. This file is chosen
// because the deploy has no such binding, so "not configured" is information
// the operator has; a live Layer is chosen because the deploy IS configured, so
// a caller has every reason to expect the method works and finds out otherwise
// in production, on a line that type-checked and reviewed clean.
//
// So: an unbuildable method in a LIVE Layer gets implemented, deleted from the
// service interface, or degraded where nothing downstream decides on the
// degraded answer — never parked on a `die`. `browser.newPage` was parked on
// one and is gone. A live Layer still carrying a `die` is a violation to fix,
// not a precedent to copy. The rule, and how to pick between the three
// endings, is written up in AGENTS.md § Conventions.
//
// Live as of PR8: `Cache` (R2-backed, see cache-r2.ts — always wired) and
// `Config` (KV-backed, see config-kv.ts — wired when the `CONFIG_KV` binding
// is present, else `ConfigDeferred` below). `Checks` went live in PR6.
// `Browser` went live in V2 (PR9) as `makeBrowserRenderingLive`; this Layer is
// the answer for a deploy with no Browser Rendering configured.
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4 + § PR6 + § PR8.

import { Effect, Layer } from "effect";
import {
  Browser,
  BrowserUnavailable,
  type BrowserService,
  ChildRuns,
  type ChildRunsService,
  Cloudflare,
  type CloudflareService,
  Config,
  type ConfigService,
  Github,
  GitHubApiError,
  type GithubService,
  ModelGateway,
  ModelGatewayError,
  type ModelGatewayService,
  Oidc,
  OidcSigningFailed,
  type OidcService,
} from "@fractalboxdev/flare-dispatch-core";

/** Browser — Browser Rendering binding deferred to V2 (PR9). */
export const BrowserDeferred: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newCDPSession: () =>
      Effect.fail(
        new BrowserUnavailable({
          reason: "transient",
        }),
      ),
  }))(),
);

/**
 * ChildRuns — the fallback when no `RUNS_WORKFLOW` binding is threaded into the
 * runtime. `RUNS_WORKFLOW` is a required Dispatcher binding, so the live runtime
 * always wires `makeChildRunsLive`; this stub only covers a runtime built
 * without it (a stand-alone capability harness). A run that calls
 * `spawnChildRun` on such a runtime dies loudly rather than silently dropping
 * the fan-out.
 */
export const ChildRunsDeferred: Layer.Layer<ChildRuns> = Layer.succeed(
  ChildRuns,
  ((): ChildRunsService => ({
    spawn: ({ run }) =>
      Effect.die(`spawnChildRun: no RUNS_WORKFLOW binding on this runtime (run="${run}")`),
    handoffAdmission: () =>
      Effect.die("handoffChildAdmission: no RUNS_WORKFLOW binding on this runtime"),
    poll: () => Effect.die("waitForChildren: no RUNS_WORKFLOW binding on this runtime"),
  }))(),
);

/**
 * Config — the fallback when a deploy has no `CONFIG_KV` namespace. A run that
 * reads config on such a deploy dies rather than silently seeing every key as
 * unset. A deploy with the binding gets the live `makeConfigKvLive` Layer.
 */
export const ConfigDeferred: Layer.Layer<Config> = Layer.succeed(
  Config,
  ((): ConfigService => ({
    get: () => Effect.die("config.get: no CONFIG_KV binding on this deploy"),
    getJSON: () => Effect.die("config.getJSON: no CONFIG_KV binding on this deploy"),
  }))(),
);

/**
 * Github — the fallback for a deploy with no App credentials. The Tag exists so
 * a run author can write `github.issues(...)` and unit-test it against the
 * in-memory fake (`GithubFake` in `@fractalboxdev/flare-dispatch-core/testing`).
 *
 * Every method here answers the *degraded* way its live twin does: a read whose
 * empty answer would be mistaken for data fails; a read whose empty answer is
 * honest returns empty; a write logs and skips. Nothing here dies — a die in a
 * Layer selected by "this deploy is not configured" is a crash on a path the
 * operator has already been told about.
 */
export const GithubDeferred: Layer.Layer<Github> = Layer.succeed(
  Github,
  ((): GithubService => ({
    // `actionRuns` (a read) degrades to empty on an uncredentialed deploy — a
    // Schedule-mode sweep simply finds nothing rather than dying. The live
    // credentialed path is `makeGithubLive` (github-live.ts).
    actionRuns: () =>
      Effect.logInfo("github.actionRuns skipped (no GitHub App credentials) — empty").pipe(
        Effect.as([]),
      ),
    // `pullRequestHistory` and `readTextFile` are reads whose degraded answer
    // would be *indistinguishable from data*: an empty history reads as "never
    // proposed", a missing file as "nothing declined". Both would make a caller
    // decide suppression wrongly and silently, so an uncredentialed deploy
    // fails them instead — which is what lets that caller fail open loudly.
    pullRequestHistory: () =>
      Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    readTextFile: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    // `branchHead` has no empty answer at all — any string would be read as a SHA.
    branchHead: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    // An empty PR list is a real answer — "no pull request" — so it fails too.
    commitPullRequests: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    pullRequest: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    appendMeasureNote: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    // `issues` is the same class: an empty list reads as "nothing to triage",
    // which a scheduled run would act on by reporting a clean estate.
    issues: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    // `openIssue` is the one WRITE in the fail class, because the issue it opens
    // is the artifact and not a report of one. A logged skip here discards the
    // question with nothing left holding it — no branch, no file, no second
    // copy — and the run would report a clean sweep having asked nothing.
    openIssue: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    // The state-machine writes degrade to a logged no-op, like `pullReview`.
    addIssueLabels: ({ repo, issue }) =>
      Effect.logInfo(
        `github.addIssueLabels skipped (no GitHub App credentials) — ${repo}#${issue} unlabelled`,
      ),
    removeIssueLabel: ({ repo, issue }) =>
      Effect.logInfo(
        `github.removeIssueLabel skipped (no GitHub App credentials) — ${repo}#${issue} unchanged`,
      ),
    commentOnIssue: ({ repo, issue }) =>
      Effect.logInfo(
        `github.commentOnIssue skipped (no GitHub App credentials) — ${repo}#${issue} not commented`,
      ),
    closeIssueAsDuplicate: ({ repo, issue, duplicateOf }) =>
      Effect.logInfo(
        `github.closeIssueAsDuplicate skipped (no GitHub App credentials) — ${repo}#${issue} (dup of #${duplicateOf}) left open`,
      ),
    closeBotIssue: ({ repo, issue }) =>
      Effect.logInfo(
        `github.closeBotIssue skipped (no GitHub App credentials) — ${repo}#${issue} left open`,
      ).pipe(Effect.as({ closed: false, reason: "uncredentialed", number: issue } as const)),
    // `pullReview` is *reporting*, not correctness — a deploy without GitHub
    // App credentials degrades to a logged no-op (the same posture as the no-op
    // `Checks` Layer), never failing an otherwise-green run. The live
    // credentialed path is `makeGithubLive` (github-live.ts).
    pullReview: ({ repo, pr }) =>
      Effect.logInfo(
        `github.pullReview skipped (no GitHub App credentials) — PR comment on ${repo}#${pr} not posted`,
      ),
    // `openDraftPullRequest` (a content write) degrades to a logged no-op, the
    // same posture as `pullReview`. The recipe sees `created: false`.
    openDraftPullRequest: ({ repo, headBranch }) =>
      Effect.logInfo(
        `github.openDraftPullRequest skipped (no GitHub App credentials) — ${repo}#${headBranch} not opened`,
      ).pipe(Effect.as({ number: 0, url: "", created: false, skipped: false })),
    closeDraftPullRequest: ({ repo, headBranch }) =>
      Effect.logInfo(
        `github.closeDraftPullRequest skipped (no GitHub App credentials) — ${repo}#${headBranch} left open`,
      ).pipe(Effect.as({ closed: false, reason: "uncredentialed" } as const)),
    // `createRelease` (a release write) degrades to a logged no-op, the same
    // posture as the other writes. The recipe sees `published: false`.
    createRelease: ({ repo, tag }) =>
      Effect.logInfo(
        `github.createRelease skipped (no GitHub App credentials) — ${repo}@${tag} not published`,
      ).pipe(Effect.as({ id: 0, url: "", tag, published: false })),
    tagCommit: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    tagTarget: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    commitOnDefaultBranch: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    releaseByTag: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    publishRelease: () => Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" })),
    publishReleaseAsset: () => Effect.fail(new GitHubApiError({ status: 0, reason: "other" })),
    publishContainerImage: () => Effect.fail(new GitHubApiError({ status: 0, reason: "other" })),
  }))(),
);

/**
 * Cloudflare — the fallback when a deploy has no `CLOUDFLARE_API_TOKEN`. A
 * read-only capability, so the safe degradation is *empty*, not a die: a
 * Schedule-mode triage sweep finds nothing CF-side rather than failing the run.
 * The live credentialed path is `makeCloudflareLive` (cloudflare-live.ts).
 */
export const CloudflareDeferred: Layer.Layer<Cloudflare> = Layer.succeed(
  Cloudflare,
  ((): CloudflareService => ({
    deployments: () =>
      Effect.logInfo("cloudflare.deployments skipped (no CLOUDFLARE_API_TOKEN) — empty").pipe(
        Effect.as([]),
      ),
    usage: ({ windowHours } = {}) =>
      Effect.logInfo("cloudflare.usage skipped (no CLOUDFLARE_API_TOKEN) — empty snapshot").pipe(
        Effect.as({ windowHours: windowHours ?? 168, workers: [], ai: [] }),
      ),
  }))(),
);

/**
 * ModelGateway — the fallback when a deploy has no Workers AI `"ai"` binding.
 * The Tag is always supplied so a model-calling run can be tested against the
 * `ModelGatewayFake`; a live deploy without the binding fails the run with a
 * typed `ModelGatewayError` (`reason: "unknown"`) rather than silently
 * mis-behaving. Wire `makeModelGatewayLive(env.AI, gatewayId)` when the binding
 * is present. Only model-calling runs (`pr-review`) touch the Tag.
 */
export const ModelGatewayDeferred: Layer.Layer<ModelGateway> = Layer.succeed(
  ModelGateway,
  ((): ModelGatewayService => ({
    complete: ({ model }) =>
      Effect.fail(
        new ModelGatewayError({
          model,
          reason: "unknown",
          message: "modelGateway.complete: no Workers AI (`AI`) binding on this deploy",
        }),
      ),
  }))(),
);

/**
 * Oidc — the fallback when a deploy has no `OIDC_SIGNING_JWK` secret. The
 * Tag is always supplied so a run can be tested against the
 * `OidcFake`; a live deploy without the signing key fails the run with a
 * typed `OidcSigningFailed` rather than silently signing with a missing key.
 * Wire `makeOidcRenderingLive(jwk, issuer)` when the secret is present.
 */
export const OidcDeferred: Layer.Layer<Oidc> = Layer.succeed(
  Oidc,
  ((): OidcService => ({
    sign: () =>
      Effect.fail(
        new OidcSigningFailed({
          reason: "key-load",
          cause: "OIDC_SIGNING_JWK Worker secret not set on this deploy",
        }),
      ),
    // `issuer()` returns the configured issuer URL even on a no-key deploy
    // — the URL is operational metadata, not gated on key presence.
    issuer: () => Effect.succeed("https://oidc-not-configured.local"),
  }))(),
);
