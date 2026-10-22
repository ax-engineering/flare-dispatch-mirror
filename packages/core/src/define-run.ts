// @fractalboxdev/flare-dispatch-core — defineRun.
//
// `defineRun` is a passive constructor: it validates the spec at module load
// and registers the run for discovery. It binds to no runtime — the same Run
// value executes against CFRuntimeLive, Dev, or Test (specs/03-dsl.md § Layers).
//
// Spec: specs/03-dsl.md § defineRun.

import type { Effect, Schema } from "effect";
import type { RunContext } from "./context";
import type { RunError } from "./errors";
import type { AdmissionClass } from "./run-admission";
import type { WritebackSpec } from "./writeback";

export type RunLimits<I = unknown> = {
  readonly maxDurationSec: number;
  /** Maximum admission wait; defaults to the dispatcher's standard queue age. */
  readonly admissionMaxQueueAgeSec?: number | ((input: I) => number);
  /**
   * The admission class this run waits in; `interactive` runs are admitted
   * ahead of `batch` ones in the same pool. Defaults to `batch`
   * (specs/adr/0009-fast-trustworthy-verdicts.md).
   */
  readonly admissionClass?: AdmissionClass;
  readonly maxConcurrency?: number;
  readonly requiresBrowser?: boolean;
};

/**
 * A dispatch-rate cap: at most one execution per `seconds` within a `scope`.
 *
 * `scope` derives the rate-limit bucket from the run's (validated) inputs —
 * e.g. `pr-review` scopes per pull request (`pr-<number>`), so a rapid push
 * sequence on one PR collapses to one review per window while other PRs are
 * unaffected. The full cooldown key is `{run}:{repo}:{scope}`, so scopes never
 * collide across repos or runs.
 *
 * Enforced at BOTH dispatch entry points (Action-mode `/v1/dispatch` and the
 * webhook receiver) using `IDEMPOTENCY_KV`; without that binding the cooldown
 * is not enforced (best-effort, like receiver-level dedup). A dispatch landing
 * inside the window is acknowledged (202) with the prior execution's id and
 * `skipped: "cooldown"` — never an error, so a gating CI step stays green.
 */
export type CooldownSpec<I> = {
  /**
   * The code-default window length in seconds — the fallback when no operator
   * override is set. Effective floor is 60 (KV's minimum TTL). Named
   * `secondsDefault` (not `seconds`) so the definition site reads honestly: it
   * is a default, and `secondsKey` may override it — never the authoritative
   * value. Mirrors the `default<X>` + `<x>Key` convention used for every other
   * operator-tunable value (see review-agent `maxTokensDefault`/`maxTokensKey`).
   */
  readonly secondsDefault: number;
  /**
   * Optional CONFIG_KV key whose value (positive integer seconds) overrides
   * `secondsDefault` at each dispatch. Absent / unparseable / out-of-range →
   * `secondsDefault`. e.g. `"pr-review.cooldown-seconds"`.
   */
  readonly secondsKey?: string;
  /** Rate-limit bucket within `{run}:{repo}` — e.g. ``pr-${input.pr}``. */
  readonly scope: (input: I) => string;
};

/** What a run's `optIn` reads its keys from: the dispatch's inputs. */
export type OptInContext<I> = {
  readonly input: I;
};

/** The raw GitHub webhook delivery; a run narrows it per-event itself. */
export type WebhookPayload = Record<string, any>;

/** A single Webhook-mode trigger binding — see specs/04-gha-integration.md. */
export type TriggerSpec<I> = {
  readonly event: string;
  readonly actions?: readonly string[];
  readonly idempotencyKey: (ctx: { payload: WebhookPayload }) => string;
  readonly gate?: (ctx: { payload: WebhookPayload }) => boolean;
  readonly inputs: (ctx: { payload: WebhookPayload }) => I;
};

/**
 * The context a cron tick provides — there is no GitHub payload.
 * See specs/03-dsl.md § `ScheduleContext`.
 */
export type ScheduleContext = {
  readonly cron: string;
  readonly firedAt: number;
};

/**
 * A single Schedule-mode trigger binding — see specs/04-gha-integration.md
 * § Schedule mode. Mirrors `TriggerSpec` but the callbacks receive a
 * `ScheduleContext` (no webhook payload). `inputs` produces a *scope*, not a
 * concrete target — for single-target runs (e.g. nightly-e2e against a fixed
 * env), the input is the full body; for sweeps, it's coarse and the run
 * enumerates targets in its first step.
 */
export type ScheduleSpec<I> = {
  /** CF cron expression; MUST also be in wrangler `triggers.crons`. */
  readonly cron: string;
  readonly idempotencyKey: (ctx: ScheduleContext) => string;
  readonly gate?: (ctx: ScheduleContext) => boolean;
  readonly inputs: (ctx: ScheduleContext) => I;
};

/**
 * Which baked sandbox image a run executes in. The dispatcher maps this to a
 * deployed Container binding (`RUNS_SANDBOX` vs `RUNS_SANDBOX_BROWSER`) — see
 * apps/dispatcher/src/workflow.ts.
 *
 *   - `"lean"` (default) — the base sandbox image. Correct for the majority of
 *     runs AND for every `limits.requiresBrowser: true` run: those dial CF
 *     Browser Rendering over CDP (they connect *out* to a CF-managed browser),
 *     so they need NO chromium baked in the image.
 *   - `"browser"` — the image with `chromium-headless-shell` baked in. For a run
 *     that launches Playwright's OWN chromium *inside* the sandbox AND drops the
 *     `playwright install` step from its command to rely on the baked browser.
 *     No run currently does: `playwright-demo` runs chromium in-sandbox but its
 *     caller installs it, so it stays `"lean"` (depending on a separately-built
 *     image a `versions upload` can leave unprovisioned regressed it). This
 *     value is wired and available, just unused until such a run exists.
 *
 * NOTE this axis is deliberately distinct from `limits.requiresBrowser`. They
 * answer different questions: `requiresBrowser` = "reserve a CF Browser
 * Rendering slot"; `sandboxImage` = "which container image to boot". A run can
 * be `requiresBrowser: true, sandboxImage: "lean"` (CDP, no in-image browser)
 * or `requiresBrowser: false, sandboxImage: "browser"` (in-sandbox Playwright).
 */
export type SandboxImage = "lean" | "browser" | "agent" | "release";

export type RunSpec<I, O, IEnc, OEnc> = {
  readonly name: string;
  readonly version: string;
  /**
   * A fully-qualified container image URI override (e.g.
   * `registry.cloudflare.com/<acct>/<repo>:<tag>`) declaring the image this run
   * is BUILT to run in. Documentary today — several runs set it (`pr-review`,
   * `playwright-e2e`, `release-notes`) but the CF runtime does not yet pull a
   * per-run registry image; Container images are bound to DO classes at deploy.
   *
   * Do NOT confuse with `sandboxImage` below: `image` names a *specific
   * registry artifact* (a future per-run image-pull knob); `sandboxImage`
   * selects which of the deploy's ALREADY-BOUND images (`"lean" | "browser"`)
   * the dispatcher routes to — and is the field that actually drives routing.
   */
  readonly image?: string;
  /** Which baked, deploy-bound sandbox image to route this run to. Default
   * `"lean"`. Drives the dispatcher's Container-binding selection — see
   * `SandboxImage` above. */
  readonly sandboxImage?: SandboxImage;
  readonly inputs: Schema.Schema<I, IEnc>;
  readonly outputs: Schema.Schema<O, OEnc>;
  readonly limits: RunLimits<I>;
  readonly triggers?: readonly TriggerSpec<I>[];
  readonly schedules?: readonly ScheduleSpec<I>[];
  /**
   * Declares that this run can "propose a diff as a PR". When set, the run's
   * container writes a changed-files manifest + blobs to a conventional
   * artifact location; after a SUCCESSFUL run the Dispatcher Worker — never the
   * container — validates the manifest against this spec and commits it via the
   * GitHub App's Git Data API, then opens/updates a PR. The capability is
   * declared HERE (trusted, Worker-side); the container only fills in the file
   * contents within the envelope this spec allows. See `./writeback`.
   */
  readonly writeback?: WritebackSpec;
  /**
   * Optional dispatch-rate cap — at most one execution per window per scope.
   * See `CooldownSpec`. Applies to Action-mode AND webhook-mode dispatches;
   * Schedule mode is exempt (crons self-pace).
   */
  readonly cooldown?: CooldownSpec<I>;
  /**
   * The CONFIG_KV keys whose presence means the repo opted in to this run —
   * exactly the keys the run body reads its command from. The webhook
   * receiver reads them before it creates a Workflow: with none present it
   * dispatches nothing and reports the run `skipped` as `not-configured`. An
   * empty list means the inputs already carry the command (an Action or a
   * fan-out parent named it), so no read happens. A failed read dispatches.
   * The run body keeps its own opt-in check. See
   * specs/adr/0007-cost-efficient-execution.md § Dispatch only work.
   */
  readonly optIn?: (ctx: OptInContext<I>) => readonly string[];
  /**
   * Declares that this run PAUSES for a human decision partway through — it
   * hibernates in `step.waitForEvent` until a person approves or rejects, and
   * cannot finish without one.
   *
   * Declarative because a dispatcher cannot see a `waitForEvent` inside a run
   * body, and some dispatch paths have nowhere to ask. A fire-and-forget
   * origin (a Slack slash command, say) must refuse such a run at the gate
   * with an explanation rather than instantiate a Workflow that parks for
   * hours while the caller sees nothing.
   *
   * NOT for a run that merely waits on an external event — `email-otp-login`
   * hibernates for a verification email, which arrives on its own. The
   * distinction is whether a PERSON has to decide.
   */
  readonly humanGate?: HumanGateSpec;
  /**
   * Serializes executions that share a group: at most one runs at a time, and
   * while it runs, only the most recently dispatched waiter survives — an
   * older waiter concludes `RunSkipped` naming the revision that replaced it.
   * A running execution is never cancelled or skipped by a newer one. See
   * `SerializeSpec`.
   */
  readonly serialize?: (input: I) => SerializeSpec | undefined;
  /**
   * Cancels older executions that share a group: a newer execution of the
   * group terminates every older live one — queued or running — together with
   * its children, releases their admission slots, and concludes their check
   * runs `cancelled`; an older one that registers after a newer one cancels
   * itself. A re-run (an execution carrying `retryOf`) joins the group and
   * cancels nothing. See `SupersedeSpec`.
   */
  readonly supersede?: (input: I) => SupersedeSpec | undefined;
  /**
   * This run joins every child it spawns, so a child still waiting for an
   * admission slot once this run's row has ended has no reader for its verdict:
   * it leaves the queue `cancelled`. A run that spawns children without
   * waiting on them leaves this unset, and its children outlive it.
   */
  readonly joinsChildren?: boolean;
  readonly run: (input: I) => Effect.Effect<O, RunError, RunContext>;
};

/**
 * The serialization group one execution joins, derived from its decoded
 * inputs. `undefined` from `serialize` opts that execution out.
 */
export type SerializeSpec = {
  /** Executions with equal `group` strings never overlap. */
  readonly group: string;
  /**
   * What this execution acts on (a commit SHA for a deploy) — named in the
   * skip reason of every waiter it replaces, and in a waiter's queued summary.
   */
  readonly revision: string;
  /**
   * The revision that is current for the group right now (a deploy's branch
   * head), or `undefined` when unknown. Read once, before the execution joins
   * the queue: an execution whose `revision` is not current skips at once and
   * supersedes nothing, and a known current revision also supersedes every
   * waiter that is not it, whenever that waiter arrived. Omitted → arrival
   * order alone decides.
   */
  readonly current?: Effect.Effect<string | undefined, never, RunContext>;
};

/**
 * The supersession group one execution joins. `undefined` from `supersede`
 * opts that execution out.
 */
export type SupersedeSpec = {
  /** Executions with equal `group` strings: only the newest stays live. */
  readonly group: string;
  /**
   * The member's revision rank — larger is newer — such as the pull request's
   * `updated_at` in ms. A member registering below a live member's rank cancels
   * itself instead of the higher one. Omitted, the rank is the registration
   * time; every member of one group supplies a rank or none does.
   */
  readonly order?: number;
};

/**
 * A run's human-decision gate. `reason` is operator-facing prose, quoted
 * verbatim in the refusal a fire-and-forget dispatch path answers with, so it
 * reads as a sentence fragment completing "…needs a human decision because X".
 */
export type HumanGateSpec = {
  readonly reason: string;
};

/** A defined run — a portable value, not bound to any runtime. */
export type Run<I, O> = RunSpec<I, O, unknown, unknown> & {
  readonly _tag: "Run";
};

/** kebab-case: lowercase alphanumerics, single hyphens, no leading/trailing. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A pragmatic semver match — `major.minor.patch` with optional pre-release. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export const defineRun = <I, O, IEnc, OEnc>(spec: RunSpec<I, O, IEnc, OEnc>): Run<I, O> => {
  // Load-time validation: a malformed run spec is a build-time bug, not a
  // dispatch-time surprise — fail fast at module load. (specs/03-dsl.md
  // § defineRun: "validates the spec at module load".)
  if (!KEBAB_CASE.test(spec.name)) {
    throw new Error(`defineRun: \`name\` must be kebab-case, got ${JSON.stringify(spec.name)}`);
  }
  if (!SEMVER.test(spec.version)) {
    throw new Error(
      `defineRun: \`version\` must be semver (major.minor.patch), got ${JSON.stringify(
        spec.version,
      )} for run "${spec.name}"`,
    );
  }
  if (!Number.isFinite(spec.limits.maxDurationSec) || spec.limits.maxDurationSec <= 0) {
    throw new Error(
      `defineRun: \`limits.maxDurationSec\` must be a positive number, got ${spec.limits.maxDurationSec} for run "${spec.name}"`,
    );
  }
  if (
    spec.cooldown !== undefined &&
    (!Number.isFinite(spec.cooldown.secondsDefault) || spec.cooldown.secondsDefault <= 0)
  ) {
    throw new Error(
      `defineRun: \`cooldown.secondsDefault\` must be a positive number, got ${spec.cooldown.secondsDefault} for run "${spec.name}"`,
    );
  }
  if (spec.cooldown?.secondsKey !== undefined && spec.cooldown.secondsKey.trim().length === 0) {
    throw new Error(
      `defineRun: \`cooldown.secondsKey\` must be a non-empty string for run "${spec.name}"`,
    );
  }
  if (spec.writeback !== undefined) {
    const wb = spec.writeback;
    const branchName = typeof wb.branch === "string" ? wb.branch : wb.branch.prefix;
    if (branchName.trim().length === 0) {
      throw new Error(
        `defineRun: \`writeback.branch\` must be a non-empty branch name (or { prefix }) for run "${spec.name}"`,
      );
    }
    if (wb.commitMessage.trim().length === 0) {
      throw new Error(
        `defineRun: \`writeback.commitMessage\` must be non-empty for run "${spec.name}"`,
      );
    }
    if (wb.maxBytes !== undefined && wb.maxBytes <= 0) {
      throw new Error(
        `defineRun: \`writeback.maxBytes\` must be positive, got ${wb.maxBytes} for run "${spec.name}"`,
      );
    }
    if (wb.maxFiles !== undefined && wb.maxFiles <= 0) {
      throw new Error(
        `defineRun: \`writeback.maxFiles\` must be positive, got ${wb.maxFiles} for run "${spec.name}"`,
      );
    }
  }
  if (spec.humanGate !== undefined && spec.humanGate.reason.trim().length === 0) {
    throw new Error(
      `defineRun: \`humanGate.reason\` must be non-empty — it is quoted verbatim in the refusal a fire-and-forget dispatch answers with — for run "${spec.name}"`,
    );
  }
  return { ...spec, _tag: "Run" } as Run<I, O>;
};
