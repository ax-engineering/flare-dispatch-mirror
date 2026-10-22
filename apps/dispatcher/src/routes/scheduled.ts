// FlareDispatch Dispatcher — Schedule-mode handler.
//
// The wall-clock dispatch path: a Cloudflare Cron Trigger (declared in
// `wrangler.jsonc` `triggers.crons`) fires the Worker's `scheduled()` handler;
// this module routes the firing `controller.cron` to every run in the registry
// whose `schedules[].cron` matches, applies each match's `gate`, computes the
// `idempotencyKey`, and instantiates a `RunWorkflow` with that key as the
// Workflow id (CF Workflows treats a duplicate `create({ id })` as a no-op —
// that is the free dedup the spec relies on).
//
// Spec: specs/04-gha-integration.md § Schedule mode + § Receiver dedup,
//       specs/03-dsl.md § schedules.
//
// --- Three deliberate departures from the dispatch route ---------------------
//
// 1. No HMAC verify. A cron tick is a Cloudflare-internal signal, not an
//    inbound request — there is no body and no caller to authenticate. The
//    handler trusts `controller.cron` + `controller.scheduledTime` as
//    delivered by the runtime.
//
// 2. No `inputs` Schema validation against the run. `schedules[].inputs(ctx)`
//    is in-process code in the run module — a malformed input is a build-time
//    bug, not a dispatch-time surprise. Validation is what `defineRun`'s load-
//    time check already enforces. (The Workflow itself still decodes against
//    `run.inputs` when it picks up the payload — that catches drift between
//    `schedules.inputs` and the schema.)
//
// 3. No 4xx return shape. The Cron Trigger does not consume a response body;
//    this handler returns `void` after firing whatever matched, logging
//    "warn" if `controller.cron` matched nothing on this deploy (likely a
//    drift between `wrangler.jsonc` and the registered runs' `schedules`).
//
// --- Idempotency / dedup -----------------------------------------------------
//
// The execution's ULID is *also* the Workflow instance id, the same way
// dispatch.ts uses a freshly-minted ULID. For Schedule mode we additionally
// pass `idempotencyKey(ctx)` as the Workflow id — collapsing duplicate cron
// deliveries (CF Cron Triggers can fire twice in pathological cases) and
// any same-window redelivery from a Worker recycle. The `RunWorkflow`'s
// own `executions` D1 row is keyed off the *Workflow instance* id, so a
// dedup-collapsed second call is a literal no-op end-to-end.

import {
  getInstallationToken,
  readBranchHead,
  resolveRepoInstallationId,
} from "@fractalboxdev/flare-dispatch-github-app";
import { makeChecksGithubService } from "@fractalboxdev/flare-dispatch-runtime-cf/checks-github";
import { Effect } from "effect";
import type { ChecksService } from "@fractalboxdev/flare-dispatch-core";
import {
  DELIVERY_SWEEP_CRON,
  type DeliverySweepPorts,
  sweepUndelivered,
  type UndeliveredRow,
} from "../delivery-sweep";
import { toInstanceId } from "../instance-id";
import { type ScheduleMatch, schedulesByCron } from "../registry";
import type { Env } from "../env";

/** The installation covering a repo and the head commit of one of its branches. */
export type ScheduledHead = { readonly installationId: number; readonly sha: string };

/**
 * Resolve the GitHub App installation for `repo` and the head of `branch`, or
 * `undefined` when the deploy has no App credentials, the App is not installed
 * on the repo, or GitHub fails the read — the run then fires without a
 * check-run, as every scheduled run did before.
 */
export type ResolveScheduledHead = (
  repo: string,
  branch: string,
) => Promise<ScheduledHead | undefined>;

/** The live resolver: App JWT → repo installation → installation token → branch ref. */
export const githubScheduledHead =
  (env: Env): ResolveScheduledHead =>
  async (repo, branch) => {
    const appId = env.GITHUB_APP_ID;
    const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
    if (appId === undefined || privateKeyPem === undefined) return undefined;
    try {
      const installationId = await resolveRepoInstallationId({ appId, privateKeyPem, repo });
      const token = await getInstallationToken({ appId, privateKeyPem, installationId });
      const sha = await readBranchHead({ token, repo, branch });
      return { installationId, sha };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[scheduled] no check-run for ${repo}:${branch} — ${message}`);
      return undefined;
    }
  };

/** Runs the verdict reconcile sweep for one tick. */
export type RunDeliverySweep = () => Promise<void>;

/** A D1 row as the undelivered-verdict query returns it. */
type UndeliveredDbRow = {
  id: string;
  run: string;
  repo: string;
  sha: string;
  status: UndeliveredRow["status"];
  attempt: number;
  input_json: string;
  check_run_id: string | number;
  installation_id: number;
  completed_at: number;
};

/** The sweep's D1 + GitHub ports for this deploy, or `undefined` without App credentials. */
export const liveDeliverySweepPorts = (env: Env): DeliverySweepPorts | undefined => {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (appId === undefined || privateKeyPem === undefined) return undefined;
  const db = env.RUNS_METADATA;
  // One client per installation for the tick, so its quota reads carry across rows.
  const clients = new Map<number, ChecksService>();
  const client = (installationId: number): ChecksService => {
    const existing = clients.get(installationId);
    if (existing !== undefined) return existing;
    const created = makeChecksGithubService({ appId, privateKeyPem, installationId });
    clients.set(installationId, created);
    return created;
  };
  return {
    listUndelivered: async ({ completedBefore, completedAfter, limit }) => {
      const { results } = await db
        .prepare(
          `SELECT id, run, repo, sha, status, attempt, input_json, check_run_id, installation_id, completed_at
             FROM executions
            WHERE delivered_at IS NULL AND installation_id IS NOT NULL
              AND delivery_refused_at IS NULL
              AND status IN ('success', 'failure', 'skipped')
              AND completed_at < ? AND completed_at >= ?
            ORDER BY completed_at ASC
            LIMIT ?`,
        )
        .bind(completedBefore, completedAfter, limit)
        .all<UndeliveredDbRow>();
      return results.map((r) => ({
        id: r.id,
        run: r.run,
        repo: r.repo,
        sha: r.sha,
        status: r.status,
        attempt: r.attempt,
        inputJson: r.input_json,
        checkRunId: String(r.check_run_id),
        installationId: r.installation_id,
        completedAt: r.completed_at,
      }));
    },
    conclude: (installationId, opts) => Effect.runPromise(client(installationId).conclude(opts)),
    markDelivered: async (id, checkRunId, at) => {
      await db
        .prepare(`UPDATE executions SET delivered_at = ?, check_run_id = ? WHERE id = ?`)
        .bind(at, checkRunId, id)
        .run();
    },
    markRefused: async (id, at) => {
      await db
        .prepare(`UPDATE executions SET delivery_refused_at = ? WHERE id = ?`)
        .bind(at, id)
        .run();
    },
    now: Date.now,
  };
};

/** The live sweep: a no-op on a deploy without App credentials, where no verdict is owed. */
export const liveDeliverySweep =
  (env: Env): RunDeliverySweep =>
  async () => {
    const ports = liveDeliverySweepPorts(env);
    if (ports === undefined) return;
    try {
      const result = await sweepUndelivered(ports);
      if (result.delivered + result.undelivered + result.refused + result.deferred > 0) {
        console.info(
          `[delivery-sweep] delivered=${result.delivered} undelivered=${result.undelivered} refused=${result.refused} deferred=${result.deferred}`,
        );
      }
    } catch (cause) {
      console.error(
        `[delivery-sweep] tick failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

/** Trim a long cron to fit inline in a log message. */
const fmt = (cron: string): string => (cron.length > 40 ? `${cron.slice(0, 37)}...` : cron);

/**
 * The scheduled-handler entry point — fan one cron tick out across every
 * run that subscribed to that expression. Errors from a single run's
 * `create({ id })` are caught + logged so one bad run does not poison the
 * sibling dispatches for the same tick.
 *
 * @param env             binding env (`RUNS_WORKFLOW`).
 * @param cron            `controller.cron` — the expression that fired.
 * @param scheduledTime   `controller.scheduledTime` — epoch ms.
 * @param resolveHead     installation + branch-head lookup for runs that target a branch.
 * @param deliverySweep   the verdict reconcile sweep, run on `DELIVERY_SWEEP_CRON`.
 */
export const handleScheduled = async (
  env: Env,
  cron: string,
  scheduledTime: number,
  resolveHead: ResolveScheduledHead = githubScheduledHead(env),
  deliverySweep: RunDeliverySweep = liveDeliverySweep(env),
): Promise<void> => {
  // The verdict reconcile sweep owns its own cron (delivery-sweep.ts).
  const isSweepTick = cron === DELIVERY_SWEEP_CRON;
  if (isSweepTick) await deliverySweep();

  const matches = schedulesByCron(cron);

  if (matches.length === 0) {
    if (isSweepTick) return;
    // `wrangler.jsonc` declared a cron the registry does not bind any run to.
    // Most likely a left-over expression after a run was retired, or a typo
    // between the wrangler entry and the run's `schedules[].cron`.
    console.warn(`[scheduled] cron tick "${fmt(cron)}" matched no registered runs`);
    return;
  }

  const ctx = { cron, firedAt: scheduledTime };

  await Promise.all(matches.map(async (match) => fireOne(env, match, ctx, resolveHead)));
};

/** Fire a single (run, schedule-spec) match, swallowing individual failures. */
const fireOne = async (
  env: Env,
  match: ScheduleMatch,
  ctx: { cron: string; firedAt: number },
  resolveHead: ResolveScheduledHead,
): Promise<void> => {
  const { run, schedule } = match;

  // Optional caller-side gate — freeze windows, holiday skips, etc.
  if (schedule.gate && !schedule.gate(ctx)) {
    console.info(`[scheduled] gate skipped run="${run.name}" cron="${fmt(ctx.cron)}"`);
    return;
  }

  const id = toInstanceId(schedule.idempotencyKey(ctx));
  const declared = schedule.inputs(ctx);

  // The Workflow `params` shape `RunWorkflow.run` decodes — same as dispatch.ts.
  // Schedule mode has no GitHub event; the run's own `inputs` carries the
  // target repo/ref/sha. A run whose inputs name a repo and a `refs/heads/`
  // branch, and no `sha`, is pinned here to that branch's head: the resolved
  // installation selects the live `Checks` Layer, so `RunWorkflow` opens the
  // check-run on that commit when the run starts and concludes it with the
  // run's outcome — the same code push and PR runs take. The head also rides
  // in `inputs.sha`, so the run executes against the commit the check names.
  // An unresolved head leaves `installation_id` absent and the inputs as
  // declared: the run fires, records its rows, and posts no check-run.
  const pinned = await pinBranchHead(declared, resolveHead);
  const inputs = pinned?.inputs ?? declared;
  const target = scheduleGithubTarget(inputs, pinned?.installationId);
  const params = {
    executionId: id,
    run: run.name,
    github: target,
    inputs,
  };

  try {
    await env.RUNS_WORKFLOW.create({ id, params });
    console.info(`[scheduled] fired run="${run.name}" id="${id}" cron="${fmt(ctx.cron)}"`);
  } catch (cause) {
    // CF Workflows throws on a duplicate `create({ id })` — that is the dedup
    // path. Treat it as success and move on.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/already exists|duplicate/i.test(message)) {
      console.info(`[scheduled] dedup run="${run.name}" id="${id}" cron="${fmt(ctx.cron)}"`);
      return;
    }
    console.error(`[scheduled] create failed run="${run.name}" id="${id}": ${message}`);
  }
};

/**
 * Resolve the head a branch-targeting run executes against. `undefined` when
 * the inputs name no repo, no `refs/heads/` ref, or already carry a `sha`, and
 * when the resolver finds no installation or head.
 */
const pinBranchHead = async (
  inputs: unknown,
  resolveHead: ResolveScheduledHead,
): Promise<{ inputs: Record<string, unknown>; installationId: number } | undefined> => {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  const obj = inputs as Record<string, unknown>;
  if (typeof obj.repo !== "string" || typeof obj.ref !== "string" || obj.sha !== undefined) {
    return undefined;
  }
  const branch = obj.ref.startsWith("refs/heads/") ? obj.ref.slice("refs/heads/".length) : "";
  if (branch === "") return undefined;
  const head = await resolveHead(obj.repo, branch);
  return head === undefined
    ? undefined
    : { inputs: { ...obj, sha: head.sha }, installationId: head.installationId };
};

/**
 * Synthesize the `github` block `RunWorkflow` expects. The cron tick carries
 * no GitHub payload, so we lift `repo` / `ref` / `sha` from the run's own
 * inputs when they are present. The fallback is a placeholder — the Workflow
 * uses these fields only for the executions D1 row and the (no-op) check-run
 * Layer when no `installation_id` is wired.
 *
 * `installationId` comes from `pinBranchHead`; an `installation_id` in the
 * run's own inputs is the fallback.
 */
const scheduleGithubTarget = (
  inputs: unknown,
  installationId?: number,
): { repo: string; ref: string; sha: string; installation_id?: number } => {
  const obj = (inputs ?? {}) as Record<string, unknown>;
  const repo = typeof obj.repo === "string" ? obj.repo : "schedule/unknown";
  const ref = typeof obj.ref === "string" ? obj.ref : "refs/heads/main";
  const sha =
    typeof obj.sha === "string" ? obj.sha : typeof obj.ref === "string" ? obj.ref : "main";
  const installation_id =
    installationId ?? (typeof obj.installation_id === "number" ? obj.installation_id : undefined);

  // Warn when the run's `schedules[].inputs()` returned a shape without
  // the fields the `executions` row expects — a Schema mismatch between
  // the schedule inputs and the run's own `inputs` schema. The Workflow
  // will validate again at decode time, but surfacing the mismatch here
  // gives the operator a faster diagnosis path.
  if (typeof obj.repo !== "string") {
    console.warn(
      `[scheduled] scheduleGithubTarget: inputs.repo is not a string (got ${typeof obj.repo}), falling back to "schedule/unknown"`,
    );
  }
  if (typeof obj.ref !== "string") {
    console.warn(
      `[scheduled] scheduleGithubTarget: inputs.ref is not a string (got ${typeof obj.ref}), falling back to "refs/heads/main"`,
    );
  }

  return installation_id !== undefined ? { repo, ref, sha, installation_id } : { repo, ref, sha };
};
