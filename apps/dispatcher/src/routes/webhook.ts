// FlareDispatch Dispatcher — `POST /v1/webhooks/github`.
//
// The Webhook-mode trigger entry point: the FlareDispatch GitHub App POSTs
// every event matching its subscription set to this route. The receiver
// verifies the App webhook signature, dedups on `X-GitHub-Delivery`, and
// dispatches a Workflow for every registered run whose `triggers[]` matches
// the inbound event + payload.action filter + run-supplied `gate(ctx)`.
//
// --- Strict opt-in -----------------------------------------------------------
//
// Webhook mode is OFF by default: a deploy without `GITHUB_WEBHOOK_SECRET`
// returns 503 on this route rather than silently accepting unsigned bodies.
// The Action-mode dispatch path is unaffected — both modes share the same
// router but only one needs to be configured.
//
// --- Two-layer dedup ---------------------------------------------------------
//
// Spec 04-gha § Receiver dedup:
//   * receiver-level — `IDEMPOTENCY_KV.put(deliveryId, "1", 24h)`. A repeat
//     delivery short-circuits to 202 before any trigger evaluation; Workflows
//     is never touched.
//   * Workflow-level — each trigger's `idempotencyKey(ctx)` is the Workflow
//     `instanceId`, so even a missed receiver-level guard collapses at
//     `RUNS_WORKFLOW.create({ id })`. A scheduled sweep's child executions
//     keep the same semantic id, so a PR already reviewed at its head SHA
//     by Webhook mode is silently skipped by the nightly sweep.
//
// --- Ack window --------------------------------------------------------------
//
// GitHub expects a 2xx within 10s or it retries. This handler does only
// verify + dedup + trigger fan-out (each fan-out is a non-blocking
// `RUNS_WORKFLOW.create`); all real work — LLM calls, Octokit fetches,
// container starts — lives inside the Workflow.

import { checkAndArmCooldown } from "../cooldown";
import { verify } from "../hmac";
import { toInstanceId } from "../instance-id";
import { triggersByEvent } from "../registry";
import { resolveReleaseApproval } from "../release-approval";
import { decodeRerequest, handleRerequest } from "../rerequest";
import { signalWorkflow } from "../signal-workflow";
import type { Env } from "../env";

/** GitHub webhook signature header. */
const SIGNATURE_HEADER = "X-Hub-Signature-256";

/** TTL on receiver-dedup KV entries — spec 04-gha § Receiver dedup (24h). */
const DEDUP_TTL_SEC = 86_400;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** GitHub webhook payloads are opaque shapes; the run's trigger narrows them. */
type WebhookPayload = Record<string, unknown>;

/**
 * Synthesize a `github` block for the Workflow params. The run's `inputs(ctx)`
 * carries the run-specific shape; this block is the `executions` D1 row's
 * repo/ref/sha context + the optional `installation_id` for the check-run
 * callback. Extracted from the standard fields GitHub puts on every webhook
 * payload — `repository.full_name`, `installation.id` — plus best-effort SHA
 * extraction (deployment / pull_request / push / head_commit).
 */
export const synthesizeGithubBlock = (
  payload: WebhookPayload,
): {
  repo: string;
  ref: string;
  sha: string;
  installation_id?: number;
} => {
  const repo =
    (payload as { repository?: { full_name?: string } }).repository?.full_name ?? "unknown/unknown";
  // Best-effort SHA — `deployment.sha`, `pull_request.head.sha`,
  // `head_commit.id`, `check_run.head_sha`, `check_suite.head_sha`. A truly
  // SHA-less event falls back to "main" so the `executions` row still
  // satisfies its NOT NULL columns.
  const deploymentSha = (payload as { deployment?: { sha?: string } }).deployment?.sha;
  const prSha = (payload as { pull_request?: { head?: { sha?: string } } }).pull_request?.head?.sha;
  const commitSha = (payload as { head_commit?: { id?: string } }).head_commit?.id;
  const checkRunSha = (payload as { check_run?: { head_sha?: string } }).check_run?.head_sha;
  const checkSuiteSha = (payload as { check_suite?: { head_sha?: string } }).check_suite?.head_sha;
  const pushSha = (payload as { after?: string }).after;
  const pushRef = (payload as { ref?: string }).ref;
  // An annotated tag push's `after` is the tag object, which a check-run refuses
  // (HTTP 422); `head_commit.id` is the commit the tag names.
  const tagPush = typeof pushRef === "string" && pushRef.startsWith("refs/tags/");
  const pushedSha = tagPush ? (commitSha ?? pushSha) : (pushSha ?? commitSha);
  const sha =
    deploymentSha ?? prSha ?? pushedSha ?? checkRunSha ?? checkSuiteSha ?? "main";
  const ref =
    typeof pushRef === "string" && pushRef.startsWith("refs/") ? pushRef : "refs/heads/main";

  const installation_id = (payload as { installation?: { id?: number } }).installation?.id;

  return installation_id !== undefined ? { repo, ref, sha, installation_id } : { repo, ref, sha };
};

/** Handle `POST /v1/webhooks/github`. */
export const handleGithubWebhook = async (request: Request, env: Env): Promise<Response> => {
  // 1. Opt-in: refuse if no webhook secret is provisioned. Better than
  //    silently accepting unsigned deliveries.
  if (env.GITHUB_WEBHOOK_SECRET === undefined) {
    return json(
      {
        error: "webhook_not_configured",
        message: "GITHUB_WEBHOOK_SECRET is unset; Webhook mode is off on this deploy",
      },
      503,
    );
  }

  // 2. Read raw body bytes ONCE — what the HMAC is computed over.
  const rawBody = await request.arrayBuffer();

  // 3. Verify X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET.
  const sig = request.headers.get(SIGNATURE_HEADER);
  const ok = await verify(env.GITHUB_WEBHOOK_SECRET, sig, rawBody);
  if (!ok) {
    return json(
      {
        error: "unauthorized",
        message: "X-Hub-Signature-256 missing or invalid",
      },
      401,
    );
  }

  // 4. Required GitHub headers.
  const deliveryId = request.headers.get("X-GitHub-Delivery");
  const event = request.headers.get("X-GitHub-Event");
  if (deliveryId === null || deliveryId.length === 0) {
    return json({ error: "missing_delivery_id", message: "X-GitHub-Delivery is required" }, 400);
  }
  if (event === null || event.length === 0) {
    return json({ error: "missing_event", message: "X-GitHub-Event is required" }, 400);
  }

  // The deploy's allowlist applies before dedup, signals, reruns, and triggers.
  // App subscriptions can stay broad while Action mode owns PR-triggered work.
  if (
    env.GITHUB_WEBHOOK_EVENTS !== undefined &&
    !env.GITHUB_WEBHOOK_EVENTS.split(",").some((allowed) => allowed.trim() === event)
  ) {
    return json({ event, deliveryId, ignored: true, reason: "event_not_allowed" }, 202);
  }

  // 5. Receiver-level dedup short-circuit on X-GitHub-Delivery.
  const deliveryKey = `gh-delivery:${deliveryId}`;
  if (env.IDEMPOTENCY_KV !== undefined) {
    const seen = await env.IDEMPOTENCY_KV.get(deliveryKey);
    if (seen !== null) {
      return json({ deduped: true, deliveryId, event }, 202);
    }
  }

  // 6. Parse the body as JSON now that we've verified the bytes.
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as WebhookPayload;
  } catch (cause) {
    return json(
      {
        error: "invalid_json",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      400,
    );
  }

  // 6b. Release-approval gate (GitHub-native human-in-the-loop). A bot-authored
  //     release PR that was merged / closed-unmerged / labeled signals the
  //     `release-notes` Workflow paused on `step.waitForEvent` — no ADMIN_TOKEN,
  //     GitHub's repo permissions are the authZ. A PR event never ALSO fans out
  //     a new run, so resolve-and-ack here and return. Always 202: an instance
  //     that's already terminal (run timed out / published) is not retryable.
  const approval = resolveReleaseApproval(event, payload);
  if (approval !== undefined) {
    const outcome = await signalWorkflow(env.RUNS_WORKFLOW, approval.wfId, "release-approval", {
      decision: approval.decision,
      decider: approval.decider,
    });
    if (env.IDEMPOTENCY_KV !== undefined) {
      await env.IDEMPOTENCY_KV.put(deliveryKey, "1", {
        expirationTtl: DEDUP_TTL_SEC,
      });
    }
    return json(
      {
        event,
        deliveryId,
        releaseApproval: {
          wfId: approval.wfId,
          tag: approval.tag,
          decision: approval.decision,
          signalled: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.reason }),
        },
      },
      202,
    );
  }

  // 6c. Check re-run (GitHub's "Re-run" / "Re-run all checks" on a check this
  //     App posted). Re-dispatches the recorded execution as its next attempt
  //     (rerequest.ts) and returns: a re-run never ALSO fans out triggers, so
  //     a trigger on `check_run` / `check_suite` sees every action but
  //     `rerequested`. Always 202 — a refusal is reported, not retried.
  const rerequest = decodeRerequest(event, payload);
  if (rerequest !== undefined) {
    const outcomes = await handleRerequest(
      env,
      rerequest,
      env.PUBLIC_ORIGIN ?? new URL(request.url).origin,
    );
    if (env.IDEMPOTENCY_KV !== undefined) {
      await env.IDEMPOTENCY_KV.put(deliveryKey, "1", {
        expirationTtl: DEDUP_TTL_SEC,
      });
    }
    return json({ event, deliveryId, rerun: outcomes }, 202);
  }

  // 7. Look up every (run, trigger) whose event matches. Filter by the
  //    trigger's `actions[]` against `payload.action`. Then evaluate `gate`.
  //    Each surviving trigger fans out to a Workflow.create.
  const matches = triggersByEvent(event);
  const payloadAction =
    typeof (payload as { action?: unknown }).action === "string"
      ? (payload as { action: string }).action
      : undefined;

  // GitHub's `action` field is always a string when present, but a
  // non-string value (beta API, unexpected event shape) would silently
  // fail to match any trigger. Surface it so the operator can diagnose.
  if ((payload as { action?: unknown }).action !== undefined && payloadAction === undefined) {
    console.warn(
      `[webhook] event "${event}" has a non-string action field — no trigger actions[] filter will match`,
    );
  }

  const dispatched: Array<{ run: string; executionId: string }> = [];
  const skipped: Array<{
    run: string;
    executionId: string;
    reason: "cooldown";
    retryAfterSec: number;
  }> = [];
  for (const { run, trigger } of matches) {
    if (
      trigger.actions !== undefined &&
      (payloadAction === undefined || !trigger.actions.includes(payloadAction))
    ) {
      continue;
    }
    const ctx = { payload };
    if (trigger.gate && !trigger.gate(ctx)) continue;

    const id = toInstanceId(trigger.idempotencyKey(ctx));
    const inputs = trigger.inputs(ctx);

    // Run cooldown (when declared) — same check-and-arm Action mode applies,
    // so the cap holds across BOTH dispatch paths. A skipped trigger is
    // reported (not silently dropped) with the execution it collapsed into.
    const cooldownVerdict = await checkAndArmCooldown({
      kv: env.IDEMPOTENCY_KV,
      configKv: env.CONFIG_KV,
      runName: run.name,
      cooldown: run.cooldown,
      repo: synthesizeGithubBlock(payload).repo,
      inputs,
      executionId: id,
      now: Date.now(),
    });
    if (cooldownVerdict.state === "cooling") {
      skipped.push({
        run: run.name,
        executionId: cooldownVerdict.priorExecutionId,
        reason: "cooldown",
        retryAfterSec: cooldownVerdict.retryAfterSec,
      });
      continue;
    }

    const params = {
      executionId: id,
      run: run.name,
      github: synthesizeGithubBlock(payload),
      inputs,
      // The dispatcher's public origin — same resolution as dispatch.ts /
      // deploy.ts / signals-webhook.ts. A webhook dispatch HAS a request, so
      // capture the origin here instead of leaving the Workflow to fall back
      // to `PUBLIC_ORIGIN` (unset on most BYOC deploys). Without it the
      // check-run summaries of webhook-triggered runs lose their tokened
      // "view full logs ↗" viewer link and artifact URLs render relative
      // (GitHub-broken).
      origin: env.PUBLIC_ORIGIN ?? new URL(request.url).origin,
    };

    try {
      await env.RUNS_WORKFLOW.create({ id, params });
      dispatched.push({ run: run.name, executionId: id });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // CF Workflows raises on duplicate `create({ id })` — that IS the
      // dedup path. Treat it as a successful dispatch.
      if (/already exists|duplicate/i.test(message)) {
        dispatched.push({ run: run.name, executionId: id });
        continue;
      }
      // A non-dedup failure on one trigger must not poison sibling triggers.
      console.error(`[webhook] create failed run="${run.name}" id="${id}": ${message}`);
    }
  }

  // 8. Record the delivery dedup token AFTER fan-out. (Pre-record would let a
  //    transient Workflow.create failure leave us thinking we've dispatched.)
  if (env.IDEMPOTENCY_KV !== undefined) {
    await env.IDEMPOTENCY_KV.put(deliveryKey, "1", {
      expirationTtl: DEDUP_TTL_SEC,
    });
  }

  return json(
    {
      event,
      deliveryId,
      dispatched,
      // Shape-stable: `skipped` appears only when a cooldown actually fired.
      ...(skipped.length > 0 ? { skipped } : {}),
    },
    202,
  );
};
