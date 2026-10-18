// @fractalboxdev/flare-dispatch-core — the `checks` capability (GitHub check-runs).
//
// `ChecksService` posts the run's green/red verdict back to the originating
// commit as a GitHub check-run: `create` on run start (status `in_progress`),
// `update` on run end (status `completed` + a conclusion). The live binding
// (PR6's `ChecksGithubLive`) uses a GitHub App installation token; the fake
// records the calls for unit-test assertions.
//
// Spec: specs/pm/plan.md § 3 (V0 layout), specs/04-gha-integration.md
// § Check-runs callback.

import { Context, Effect } from "effect";

/** A check-run conclusion — the terminal verdict GitHub renders. */
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out";

/**
 * Whether a check-run still renders as running. `unknown` when it cannot be
 * read — a caller deciding whether to conclude it leaves an `unknown` one alone.
 */
export type CheckRunState = "completed" | "open" | "unknown";

/** The output block GitHub renders under the check-run. */
export type CheckOutput = {
  readonly title: string;
  readonly summary: string;
};

/**
 * The service contract a runtime Layer implements. `create` returns the
 * GitHub-assigned check-run id, which the caller threads into `update`.
 */
export interface ChecksService {
  /** Create a check-run in `in_progress`; resolves to its check-run id. */
  readonly create: (opts: {
    repo: string;
    sha: string;
    name: string;
    output?: CheckOutput;
    /** Optional "Details" link — e.g. the Cloudflare Workflows instance page. */
    detailsUrl?: string;
  }) => Effect.Effect<string>;

  /**
   * Refresh a still-running check-run's output WITHOUT concluding it
   * (`status: in_progress`) — e.g. the run-admission gate's
   * "Queued — waiting for a sandbox slot behind N runs" position updates.
   */
  readonly progress: (opts: {
    repo: string;
    checkRunId: string;
    output: CheckOutput;
    /** Optional "Details" link, preserved across the update. */
    detailsUrl?: string;
  }) => Effect.Effect<void>;

  /** Read whether a check-run is completed. Total: an unreadable one is `unknown`. */
  readonly status: (opts: { repo: string; checkRunId: string }) => Effect.Effect<CheckRunState>;

  /** Complete a check-run with a conclusion. */
  readonly update: (opts: {
    repo: string;
    checkRunId: string;
    conclusion: CheckConclusion;
    output?: CheckOutput;
    /** Optional "Details" link, preserved on completion. */
    detailsUrl?: string;
  }) => Effect.Effect<void>;
}

/** Context.Tag — the GitHub check-run dependency a run carries. */
export class Checks extends Context.Tag("@fractalboxdev/flare-dispatch-core/Checks")<
  Checks,
  ChecksService
>() {}

/**
 * The `checks` accessor namespace — reads the Checks service from context and
 * delegates, so a run writes `checks.create(...)` rather than the explicit
 * `Effect.flatMap(Checks, ...)`.
 */
export const checks = {
  create: (opts: {
    repo: string;
    sha: string;
    name: string;
    output?: CheckOutput;
    detailsUrl?: string;
  }) => Effect.flatMap(Checks, (c) => c.create(opts)),
  progress: (opts: {
    repo: string;
    checkRunId: string;
    output: CheckOutput;
    detailsUrl?: string;
  }) => Effect.flatMap(Checks, (c) => c.progress(opts)),
  update: (opts: {
    repo: string;
    checkRunId: string;
    conclusion: CheckConclusion;
    output?: CheckOutput;
    detailsUrl?: string;
  }) => Effect.flatMap(Checks, (c) => c.update(opts)),
} as const;
