// FlareDispatch Dispatcher — the run registry.
//
// A name → `Run` map the routes resolve a dispatched run against. `RunWorkflow`
// (workflow.ts) keeps its own one-entry copy; this is the Dispatcher-side
// twin the `/v1/dispatch/:run` route uses to (a) 404 an unknown run and (b)
// Schema-validate `inputs` against the named run's `inputs` schema *before*
// instantiating the Workflow. `/health` lists `runNames()`.
//
// Each run slots in as another entry: `offload-test` (V0), `cdp-acceptance`
// (V2 browser acceptance, PR9), `product-demo` (V3 — Action + Schedule mode).

import type { Run, ScheduleSpec, TriggerSpec } from "@fractalboxdev/flare-dispatch-core";
import {
  cdpAcceptance,
  check,
  ciTriagePr,
  contextfulCacheWarm,
  contextfulGate,
  contextfulMeasures,
  contextfulProtocol,
  demoReel,
  deploySmoke,
  emailOtpLogin,
  finopsAudit,
  matrixFanout,
  offloadTest,
  orgSpecAudit,
  oxlint,
  playwrightDemo,
  playwrightE2E,
  prReview,
  productDemo,
  refreshFixtures,
  releaseNotes,
  contextfulRelease,
  contextfulReleaseCell,
  contextfulReleaseFormula,
  selfHealPr,
  improvePr,
  specDriftPr,
  triageIssues,
  triagePrs,
  vitestShard,
  workerDeploy,
} from "@fractalboxdev/flare-dispatch-runs";

/** name → Run. The single seam new runs are registered through. */
const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
  [cdpAcceptance.name]: cdpAcceptance as Run<unknown, unknown>,
  [deploySmoke.name]: deploySmoke as Run<unknown, unknown>,
  [matrixFanout.name]: matrixFanout as Run<unknown, unknown>,
  [playwrightE2E.name]: playwrightE2E as Run<unknown, unknown>,
  [productDemo.name]: productDemo as Run<unknown, unknown>,
  [playwrightDemo.name]: playwrightDemo as Run<unknown, unknown>,
  [prReview.name]: prReview as Run<unknown, unknown>,
  [improvePr.name]: improvePr as Run<unknown, unknown>,
  [specDriftPr.name]: specDriftPr as Run<unknown, unknown>,
  // The other half of the internal audit: `spec-drift-pr` proposes the drift a
  // machine can fix, this sweeps the estate for what needs a human answer and
  // opens ONE control-plane PR carrying them grouped and deduplicated.
  [orgSpecAudit.name]: orgSpecAudit as Run<unknown, unknown>,
  [triageIssues.name]: triageIssues as Run<unknown, unknown>,
  [triagePrs.name]: triagePrs as Run<unknown, unknown>,
  [ciTriagePr.name]: ciTriagePr as Run<unknown, unknown>,
  // The fix stage `ci-triage-pr`'s diagnosis (and `product-demo`'s confirmed
  // demo failures) escalate into. Demo-class auto-dispatch is gated OFF unless
  // `self-heal.demo.enabled=true`; the run itself is also Action-mode
  // dispatchable (`POST /v1/dispatch/self-heal-pr`). specs/08-self-healing.md.
  [selfHealPr.name]: selfHealPr as Run<unknown, unknown>,
  [refreshFixtures.name]: refreshFixtures as Run<unknown, unknown>,
  [releaseNotes.name]: releaseNotes as Run<unknown, unknown>,
  [contextfulRelease.name]: contextfulRelease as Run<unknown, unknown>,
  [contextfulReleaseCell.name]: contextfulReleaseCell as Run<unknown, unknown>,
  [contextfulReleaseFormula.name]: contextfulReleaseFormula as Run<unknown, unknown>,
  [oxlint.name]: oxlint as Run<unknown, unknown>,
  [check.name]: check as Run<unknown, unknown>,
  [contextfulGate.name]: contextfulGate as Run<unknown, unknown>,
  [contextfulCacheWarm.name]: contextfulCacheWarm as Run<unknown, unknown>,
  [vitestShard.name]: vitestShard as Run<unknown, unknown>,
  [emailOtpLogin.name]: emailOtpLogin as Run<unknown, unknown>,
  [finopsAudit.name]: finopsAudit as Run<unknown, unknown>,
  [contextfulMeasures.name]: contextfulMeasures as Run<unknown, unknown>,
  [contextfulProtocol.name]: contextfulProtocol as Run<unknown, unknown>,
  [workerDeploy.name]: workerDeploy as Run<unknown, unknown>,
  // Presentation stage for a captured demo: consumes a product-demo
  // execution's demo-bundle/v1 and renders a deck (+ MP4 when the image
  // carries ffmpeg) via autopresenter. Spawned as a child by product-demo
  // when `demo-reel.enabled=true`; also Action-mode dispatchable with an
  // explicit `bundleUrl`. specs/10-demo-bundle.md.
  [demoReel.name]: demoReel as Run<unknown, unknown>,
};

/** Resolve a run by name; `undefined` for an unknown run (→ 404). */
export const lookupRun = (name: string): Run<unknown, unknown> | undefined => RUN_REGISTRY[name];

/** The registered run names — sorted for a stable `/health` response. */
export const runNames = (): readonly string[] => Object.keys(RUN_REGISTRY).sort();

/**
 * Find every (run, schedule-spec) pair in the registry whose `cron` matches
 * the given expression — the routing primitive Schedule mode dispatches
 * through. Multiple runs MAY share one cron (the spec calls this "free dedup
 * against the other modes" — each run's child executions keep their own
 * semantic `instanceId`).
 *
 * The cron expression match is exact-string, NOT a cron-grammar comparison:
 * `controller.cron` is whatever wrangler delivered, and the run's `schedules`
 * entry MUST use the same form. The `init` CLI (specs/pm/plan.md) eventually
 * reconciles `wrangler.jsonc` + `schedules` at deploy time; until then it is
 * the operator's job to keep them in sync — a missing match is logged at
 * warn (see routes/scheduled.ts), never a crash.
 */
export type ScheduleMatch = {
  readonly run: Run<unknown, unknown>;
  readonly schedule: ScheduleSpec<unknown>;
};

export const schedulesByCron = (cron: string): readonly ScheduleMatch[] => {
  const matches: ScheduleMatch[] = [];
  for (const run of Object.values(RUN_REGISTRY)) {
    const schedules = run.schedules;
    if (!schedules) continue;
    for (const s of schedules) {
      if (s.cron === cron) {
        matches.push({ run, schedule: s as ScheduleSpec<unknown> });
      }
    }
  }
  return matches;
};

/**
 * Every registered run that declares a schedule, with the crons it declares.
 *
 * The enumeration the cron-parity test reads to answer the reverse of
 * `schedulesByCron`: not "which run does this expression wake", but "which run
 * declared a schedule nothing arms". A run exported and registered but absent
 * from `wrangler.jsonc` never fires, and nothing else in the system says so.
 */
export const scheduledRuns = (): readonly { name: string; crons: readonly string[] }[] =>
  Object.values(RUN_REGISTRY)
    .filter((run) => (run.schedules?.length ?? 0) > 0)
    .map((run) => ({ name: run.name, crons: (run.schedules ?? []).map((s) => s.cron) }));

/**
 * Find every (run, trigger-spec) pair in the registry whose `event` matches
 * the inbound GitHub webhook event. The Webhook-mode counterpart to
 * `schedulesByCron`. Filtering by trigger `actions[]` happens at the receiver
 * (spec 04-gha § Webhook mode) once we've read the payload's `action` field.
 */
export type TriggerMatch = {
  readonly run: Run<unknown, unknown>;
  readonly trigger: TriggerSpec<unknown>;
};

export const triggersByEvent = (event: string): readonly TriggerMatch[] => {
  const matches: TriggerMatch[] = [];
  for (const run of Object.values(RUN_REGISTRY)) {
    const triggers = run.triggers;
    if (!triggers) continue;
    for (const t of triggers) {
      if (t.event === event) {
        matches.push({ run, trigger: t as TriggerSpec<unknown> });
      }
    }
  }
  return matches;
};
