// FlareDispatch Dispatcher — `POST /v1/webhooks/github` acceptance tests.
//
// Drives `handleGithubWebhook` via the router with a hand-built `Request` +
// fake `Env`. Covers the spec/04-gha-integration.md § Webhook mode contract:
//   missing/invalid X-Hub-Signature-256 → 401;
//   missing X-GitHub-Delivery/Event headers → 400;
//   no secret configured → 503;
//   valid sig + matching trigger → 202, run dispatched once;
//   gate returning false → 202, dispatched: 0;
//   duplicate delivery → 202, deduped, no second Workflow.create.

import { describe, expect, it } from "vitest";
import { sign } from "../hmac";
import { handleRequest } from "../router";
import { makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import { synthesizeGithubBlock } from "./webhook";

const WEBHOOK_SECRET = "github-webhook-secret-please-rotate";
const HMAC_SECRET = "unused-but-required-by-env-shape";

/**
 * The `deployment_status` payload `deploy-smoke`'s trigger pattern-matches:
 * production environment, success state, environment_url present.
 */
const deploymentStatusPayload = {
  action: "created",
  deployment_status: {
    state: "success",
    environment_url: "https://example.com",
  },
  deployment: {
    id: 9001,
    sha: "abc123def456",
    environment: "production",
  },
  repository: { full_name: "owner/test-repo" },
  installation: { id: 99999 },
};

const webhookRequest = async (
  payload: unknown,
  opts: {
    event?: string;
    deliveryId?: string;
    sign?: boolean;
    signWith?: string;
    signature?: string;
  } = {},
): Promise<Request> => {
  const bodyText = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-GitHub-Event": opts.event ?? "deployment_status",
    "X-GitHub-Delivery": opts.deliveryId ?? "12345678-1234-1234-1234-123456789012",
  };
  if (opts.signature !== undefined) {
    headers["X-Hub-Signature-256"] = opts.signature;
  } else if (opts.sign !== false) {
    headers["X-Hub-Signature-256"] = await sign(
      opts.signWith ?? WEBHOOK_SECRET,
      new TextEncoder().encode(bodyText),
    );
  }
  return new Request("https://dispatcher.example/v1/webhooks/github", {
    method: "POST",
    headers,
    body: bodyText,
  });
};

const fixture = (
  opts: {
    withWebhookSecret?: boolean;
    withKv?: boolean;
    publicOrigin?: string;
    configKv?: KVNamespace;
  } = {},
) => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const idempotencyKv = opts.withKv ? makeFakeKv() : undefined;
  const env = makeFakeEnv({
    hmacSecret: HMAC_SECRET,
    workflow,
    storage,
    idempotencyKv: idempotencyKv?.binding,
    githubWebhookSecret: opts.withWebhookSecret === false ? undefined : WEBHOOK_SECRET,
    ...(opts.publicOrigin !== undefined ? { publicOrigin: opts.publicOrigin } : {}),
    ...(opts.configKv !== undefined ? { configKv: opts.configKv } : {}),
  });
  return { workflow, storage, env, idempotencyKv };
};

describe("POST /v1/webhooks/github — signature", () => {
  it("missing signature header → 401", async () => {
    const { env, workflow } = fixture();
    const req = await webhookRequest(deploymentStatusPayload, { sign: false });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(workflow.calls).toHaveLength(0);
  });

  it("invalid signature → 401", async () => {
    const { env, workflow } = fixture();
    const req = await webhookRequest(deploymentStatusPayload, {
      signWith: "wrong-webhook-secret",
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(workflow.calls).toHaveLength(0);
  });

  it("webhook secret not configured → 503", async () => {
    const { env, workflow } = fixture({ withWebhookSecret: false });
    const req = await webhookRequest(deploymentStatusPayload, { sign: false });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(503);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/github — headers", () => {
  it("missing X-GitHub-Delivery → 400", async () => {
    const { env } = fixture();
    const bodyText = JSON.stringify(deploymentStatusPayload);
    const sig = await sign(WEBHOOK_SECRET, new TextEncoder().encode(bodyText));
    const req = new Request("https://dispatcher.example/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-GitHub-Event": "deployment_status",
        "X-Hub-Signature-256": sig,
      },
      body: bodyText,
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
  });

  it("missing X-GitHub-Event → 400", async () => {
    const { env } = fixture();
    const bodyText = JSON.stringify(deploymentStatusPayload);
    const sig = await sign(WEBHOOK_SECRET, new TextEncoder().encode(bodyText));
    const req = new Request("https://dispatcher.example/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-GitHub-Delivery": "abc",
        "X-Hub-Signature-256": sig,
      },
      body: bodyText,
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/webhooks/github — event allowlist", () => {
  const prPayload = {
    action: "synchronize",
    pull_request: {
      number: 7,
      draft: false,
      labels: [],
      user: { login: "octocat" },
      head: { sha: "aaaa111122223333" },
      base: { sha: "base000000000000" },
    },
    repository: { full_name: "owner/test-repo" },
    installation: { id: 99999 },
  };

  it.each(["pull_request", "push", "deployment_status"])(
    "check-only mode ignores %s without dispatching or recording dedup",
    async (event) => {
      const { env, workflow, idempotencyKv } = fixture({ withKv: true });
      const res = await handleRequest(
        await webhookRequest(event === "pull_request" ? prPayload : deploymentStatusPayload, {
          event,
        }),
        { ...env, GITHUB_WEBHOOK_EVENTS: "check_run,check_suite" },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ignored: true, reason: "event_not_allowed" });
      expect(workflow.calls).toHaveLength(0);
      expect(workflow.events).toHaveLength(0);
      expect(
        await idempotencyKv!.binding.get("gh-delivery:12345678-1234-1234-1234-123456789012"),
      ).toBeNull();
    },
  );

  it("authenticates excluded deliveries before ignoring them", async () => {
    const { env } = fixture();
    const res = await handleRequest(await webhookRequest(prPayload, { sign: false }), {
      ...env,
      GITHUB_WEBHOOK_EVENTS: "check_run,check_suite",
    });
    expect(res.status).toBe(401);
  });

  it("trims event names and dispatches allowed triggers", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(await webhookRequest(deploymentStatusPayload), {
      ...env,
      GITHUB_WEBHOOK_EVENTS: " check_run, deployment_status ",
    });
    expect(res.status).toBe(202);
    expect(workflow.calls).toHaveLength(1);
  });

  it("an empty allowlist dispatches nothing", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(await webhookRequest(deploymentStatusPayload), {
      ...env,
      GITHUB_WEBHOOK_EVENTS: "",
    });
    expect(res.status).toBe(202);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/github — trigger evaluation", () => {
  it("preserves the pushed tag ref and names the tagged commit for release triggers", () => {
    // An annotated tag's `after` is the tag object; a check-run needs the commit it tags.
    expect(
      synthesizeGithubBlock({
        ref: "refs/tags/v1.2.3",
        after: "a".repeat(40),
        head_commit: { id: "b".repeat(40) },
        repository: { full_name: "owner/test-repo" },
        installation: { id: 99999 },
      }),
    ).toEqual({
      repo: "owner/test-repo",
      ref: "refs/tags/v1.2.3",
      sha: "b".repeat(40),
      installation_id: 99999,
    });
  });

  it("a branch push names its `after` commit", () => {
    expect(
      synthesizeGithubBlock({
        ref: "refs/heads/main",
        after: "c".repeat(40),
        head_commit: { id: "c".repeat(40) },
        repository: { full_name: "owner/test-repo" },
      }).sha,
    ).toBe("c".repeat(40));
  });

  it("valid sig + matching deployment_status → dispatches deploy-smoke", async () => {
    const { env, workflow } = fixture();
    const req = await webhookRequest(deploymentStatusPayload);
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      event: string;
      dispatched: Array<{ run: string; executionId: string }>;
    };
    expect(body.event).toBe("deployment_status");
    expect(body.dispatched.map((d) => d.run)).toContain("deploy-smoke");

    expect(workflow.calls).toHaveLength(1);
    const call = workflow.calls[0]!;
    // The trigger's semantic idempotency key sanitized to a valid CF Workflows
    // instance id by `toInstanceId` (`:` and `/` → `_`).
    expect(call.id).toBe("deploy-smoke_owner_test-repo_9001");
    const params = call.params as {
      run: string;
      github: { repo: string; sha: string; installation_id?: number };
      inputs: { baseURL: string; paths: readonly string[] };
    };
    expect(params.run).toBe("deploy-smoke");
    expect(params.github.repo).toBe("owner/test-repo");
    expect(params.github.sha).toBe("abc123def456");
    expect(params.github.installation_id).toBe(99999);
    expect(params.inputs.baseURL).toBe("https://example.com");
    expect(params.inputs.paths).toEqual(["/", "/health", "/api/status"]);
  });

  it("params carry the request origin — the base for the summary's viewer link", async () => {
    // Without `origin` the Workflow falls back to `PUBLIC_ORIGIN`, which most
    // BYOC deploys leave unset — check-run summaries of webhook-triggered runs
    // then lose their tokened "view full logs ↗" link. Same capture as
    // dispatch.ts / deploy.ts / signals-webhook.ts.
    const { env, workflow } = fixture();
    const res = await handleRequest(await webhookRequest(deploymentStatusPayload), env);
    expect(res.status).toBe(202);
    expect((workflow.calls[0]!.params as { origin: string }).origin).toBe(
      "https://dispatcher.example",
    );
  });

  it("PUBLIC_ORIGIN wins over the request origin when set", async () => {
    // A custom domain in front of the worker — links must use the canonical
    // origin, not whatever host the webhook happened to arrive on.
    const { env, workflow } = fixture({ publicOrigin: "https://ci.example.dev" });
    const res = await handleRequest(await webhookRequest(deploymentStatusPayload), env);
    expect(res.status).toBe(202);
    expect((workflow.calls[0]!.params as { origin: string }).origin).toBe("https://ci.example.dev");
  });

  it("gate rejects non-production deployments → 202 with dispatched: 0", async () => {
    const { env, workflow } = fixture();
    const stagingPayload = {
      ...deploymentStatusPayload,
      deployment: { ...deploymentStatusPayload.deployment, environment: "staging" },
    };
    const req = await webhookRequest(stagingPayload);
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { dispatched: unknown[] };
    expect(body.dispatched).toEqual([]);
    expect(workflow.calls).toHaveLength(0);
  });

  it("unmatched event → 202 with dispatched: 0", async () => {
    const { env, workflow } = fixture();
    const req = await webhookRequest(deploymentStatusPayload, {
      event: "no_such_event",
    });
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { dispatched: unknown[] };
    expect(body.dispatched).toEqual([]);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/github — receiver dedup", () => {
  it("duplicate X-GitHub-Delivery → 202 deduped, no second Workflow.create", async () => {
    const { env, workflow, idempotencyKv } = fixture({ withKv: true });
    expect(idempotencyKv).toBeDefined();

    const req1 = await webhookRequest(deploymentStatusPayload, {
      deliveryId: "delivery-1",
    });
    const res1 = await handleRequest(req1, env);
    expect(res1.status).toBe(202);
    expect(workflow.calls).toHaveLength(1);

    const req2 = await webhookRequest(deploymentStatusPayload, {
      deliveryId: "delivery-1",
    });
    const res2 = await handleRequest(req2, env);
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { deduped?: boolean };
    expect(body2.deduped).toBe(true);
    // Workflow.create NOT called a second time.
    expect(workflow.calls).toHaveLength(1);
  });
});

describe("POST /v1/webhooks/github — run cooldown", () => {
  /** A pull_request payload passing pr-review's trigger gate. */
  const prPayload = (sha: string) => ({
    action: "synchronize",
    pull_request: {
      number: 7,
      draft: false,
      labels: [],
      user: { login: "octocat" },
      head: { sha },
      base: { sha: "base000000000000" },
    },
    repository: { full_name: "owner/test-repo" },
    installation: { id: 99999 },
  });

  it("second pr-review dispatch for the same PR inside the window → skipped", async () => {
    const { env, workflow } = fixture({ withKv: true });

    const res1 = await handleRequest(
      await webhookRequest(prPayload("aaaa111122223333"), {
        event: "pull_request",
        deliveryId: "delivery-pr-1",
      }),
      env,
    );
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as {
      dispatched: Array<{ run: string; executionId: string }>;
    };
    expect(body1.dispatched.map((d) => d.run)).toContain("pr-review");
    const firstId = body1.dispatched.find((d) => d.run === "pr-review")!.executionId;

    // A new push (different sha, different delivery) on the SAME PR, inside
    // the cooldown window: pr-review must be skipped, not re-dispatched.
    const res2 = await handleRequest(
      await webhookRequest(prPayload("bbbb444455556666"), {
        event: "pull_request",
        deliveryId: "delivery-pr-2",
      }),
      env,
    );
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as {
      dispatched: Array<{ run: string }>;
      skipped?: Array<{
        run: string;
        executionId: string;
        reason: string;
        retryAfterSec: number;
      }>;
    };
    expect(body2.dispatched.map((d) => d.run)).not.toContain("pr-review");
    expect(body2.skipped).toHaveLength(1);
    expect(body2.skipped![0]).toMatchObject({
      run: "pr-review",
      executionId: firstId,
      reason: "cooldown",
    });
    expect(body2.skipped![0]!.retryAfterSec).toBeGreaterThan(0);
    // pr-review was created exactly once — the second delivery was cooled down.
    // (offload-test also fires on pull_request and has no cooldown, so it is not
    // part of this count.)
    expect(
      workflow.calls.filter((c) => (c.params as { run: string }).run === "pr-review"),
    ).toHaveLength(1);
  });

  it("a different PR is unaffected by another PR's window", async () => {
    const { env, workflow } = fixture({ withKv: true });
    await handleRequest(
      await webhookRequest(prPayload("aaaa111122223333"), {
        event: "pull_request",
        deliveryId: "delivery-pr-3",
      }),
      env,
    );
    const other = prPayload("cccc777788889999");
    other.pull_request.number = 8;
    const res = await handleRequest(
      await webhookRequest(other, {
        event: "pull_request",
        deliveryId: "delivery-pr-4",
      }),
      env,
    );
    const body = (await res.json()) as {
      dispatched: Array<{ run: string }>;
      skipped?: unknown[];
    };
    expect(body.dispatched.map((d) => d.run)).toContain("pr-review");
    // offload-test co-fires on every pull_request (the zero-GHA test path).
    expect(body.dispatched.map((d) => d.run)).toContain("offload-test");
    expect(body.skipped).toBeUndefined();
    // Both PRs dispatch pr-review (no cross-PR cooldown); count it specifically
    // since offload-test co-fires on each.
    expect(
      workflow.calls.filter((c) => (c.params as { run: string }).run === "pr-review"),
    ).toHaveLength(2);
  });
});

describe("POST /v1/webhooks/github — release-PR approval", () => {
  const MARKER = "<!-- flare-dispatch:release-approval wf=release-notes-2026-W26 tag=v0.1.0 -->";

  const releasePr = (over: Record<string, unknown>) => ({
    action: "closed",
    sender: { login: "maintainer" },
    pull_request: {
      number: 7,
      body: `Release v0.1.0\n\n${MARKER}`,
      merged: true,
      user: { type: "Bot" },
    },
    repository: { full_name: "fractalbox/flare-dispatch" },
    ...over,
  });

  it("merged release PR → signals approve, no run dispatched", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      await webhookRequest(releasePr({}), { event: "pull_request" }),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      releaseApproval?: { decision: string; signalled: boolean; wfId: string };
    };
    expect(body.releaseApproval).toMatchObject({
      decision: "approve",
      signalled: true,
      wfId: "release-notes-2026-W26",
    });
    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0]).toEqual({
      wfId: "release-notes-2026-W26",
      type: "release-approval",
      payload: { decision: "approve", decider: "maintainer" },
    });
    // A PR approval never ALSO fans out a new run.
    expect(workflow.calls).toHaveLength(0);
  });

  it("release:reject label → signals reject", async () => {
    const { env, workflow } = fixture();
    const res = await handleRequest(
      await webhookRequest(releasePr({ action: "labeled", label: { name: "release:reject" } }), {
        event: "pull_request",
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(workflow.events[0]).toMatchObject({
      type: "release-approval",
      payload: { decision: "reject", decider: "maintainer" },
    });
  });

  it("a non-marker pull_request is not treated as an approval", async () => {
    const { env, workflow } = fixture();
    // A plain label on a human PR with no marker — resolves to nothing, and
    // `labeled` matches no run trigger, so neither a signal nor a dispatch.
    await handleRequest(
      await webhookRequest(
        releasePr({
          action: "labeled",
          label: { name: "bug" },
          pull_request: { number: 8, body: "no marker", user: { type: "User" } },
        }),
        { event: "pull_request" },
      ),
      env,
    );
    expect(workflow.events).toHaveLength(0);
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/github — pull request closed", () => {
  const REPO = "fractalboxdev/contextful";
  const closed = (merged: boolean) => ({
    action: "closed",
    repository: { full_name: REPO },
    installation: { id: 77 },
    pull_request: {
      number: 42,
      merged,
      body: "",
      user: { type: "User" },
      updated_at: "2026-10-19T10:00:05Z",
      head: { sha: "a".repeat(40), repo: { full_name: REPO } },
      base: { sha: "b".repeat(40) },
    },
  });

  it("starts one group close per superseding run and dispatches no run", async () => {
    for (const merged of [true, false]) {
      const { env, workflow } = fixture();
      const res = await handleRequest(await webhookRequest(closed(merged), { event: "pull_request" }), env);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { dispatched: unknown[]; closed?: unknown[] };
      expect(body.dispatched).toEqual([]);
      expect(workflow.calls).toHaveLength(1);
      expect(workflow.calls[0]?.params).toEqual({
        closeGroup: {
          group: `contextful-gate:${REPO}#42`,
          rank: Date.parse("2026-10-19T10:00:05Z") + 1,
          repo: REPO,
          installation_id: 77,
        },
      });
      expect(body.closed).toEqual([{ group: `contextful-gate:${REPO}#42`, instanceId: workflow.calls[0]?.id }]);
    }
  });
});

describe("POST /v1/webhooks/github — receiver opt-in", () => {
  /** A pull_request payload passing the check / offload-test gates. */
  const prPayload = {
    action: "synchronize",
    pull_request: {
      number: 7,
      draft: false,
      labels: [],
      user: { login: "octocat" },
      head: { sha: "aaaa111122223333" },
      base: { sha: "base000000000000" },
    },
    repository: { full_name: "owner/test-repo" },
    installation: { id: 99999 },
  };

  /** A default-branch check_suite payload passing worker-deploy's gate. */
  const checkSuitePayload = {
    action: "requested",
    check_suite: { head_branch: "main", head_sha: "dddd111122223333" },
    repository: { full_name: "owner/test-repo", default_branch: "main" },
    installation: { id: 99999 },
  };

  type Body = {
    dispatched: Array<{ run: string }>;
    skipped?: Array<{ run: string; reason: string }>;
  };

  const deliver = async (
    env: Parameters<typeof handleRequest>[1],
    payload: unknown,
    event: string,
  ): Promise<Body> => {
    const res = await handleRequest(await webhookRequest(payload, { event }), env);
    expect(res.status).toBe(202);
    return (await res.json()) as Body;
  };

  const createdRuns = (workflow: ReturnType<typeof makeFakeWorkflow>): string[] =>
    workflow.calls.map((c) => (c.params as { run: string }).run);

  it("a repo with none of a run's keys creates no Workflow and lists it not-configured", async () => {
    const configKv = makeFakeKv();
    const { env, workflow } = fixture({ configKv: configKv.binding });

    const body = await deliver(env, prPayload, "pull_request");

    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { run: "check", reason: "not-configured" },
        { run: "offload-test", reason: "not-configured" },
      ]),
    );
    expect(body.dispatched.map((d) => d.run)).not.toContain("check");
    expect(body.dispatched.map((d) => d.run)).not.toContain("offload-test");
    expect(createdRuns(workflow)).not.toContain("check");
    expect(createdRuns(workflow)).not.toContain("offload-test");
    // A run without `optIn` dispatches as before.
    expect(body.dispatched.map((d) => d.run)).toContain("pr-review");
  });

  it("a present per-repo command key dispatches that run only", async () => {
    const configKv = makeFakeKv();
    configKv.store.set("check.command:owner/test-repo", "pnpm lint");
    const { env, workflow } = fixture({ configKv: configKv.binding });

    const body = await deliver(env, prPayload, "pull_request");

    expect(body.dispatched.map((d) => d.run)).toContain("check");
    expect(createdRuns(workflow)).toContain("check");
    expect(body.skipped).toEqual([{ run: "offload-test", reason: "not-configured" }]);
  });

  it("offload-test opts in through the dispatcher-wide command or the stages key", async () => {
    for (const key of ["offload-test.command", "offload-test.stages:owner/test-repo"]) {
      const configKv = makeFakeKv();
      configKv.store.set(key, "unit");
      const { env } = fixture({ configKv: configKv.binding });

      const body = await deliver(env, prPayload, "pull_request");

      expect(body.dispatched.map((d) => d.run)).toContain("offload-test");
      expect(body.skipped?.map((s) => s.run)).not.toContain("offload-test");
    }
  });

  it("worker-deploy skips a repo without its command key and dispatches one with it", async () => {
    const configKv = makeFakeKv();
    const { env, workflow } = fixture({ configKv: configKv.binding });

    const skippedBody = await deliver(env, checkSuitePayload, "check_suite");
    expect(skippedBody.skipped).toEqual(
      expect.arrayContaining([{ run: "worker-deploy", reason: "not-configured" }]),
    );
    expect(createdRuns(workflow)).not.toContain("worker-deploy");

    configKv.store.set("worker-deploy.command:owner/test-repo", "pnpm deploy");
    const { env: configured, workflow: configuredWorkflow } = fixture({
      configKv: configKv.binding,
    });
    const body = await deliver(configured, checkSuitePayload, "check_suite");
    expect(body.dispatched.map((d) => d.run)).toContain("worker-deploy");
    expect(createdRuns(configuredWorkflow)).toContain("worker-deploy");
  });

  it("a failed opt-in read dispatches as before and logs", async () => {
    const configKv = {
      get: async () => {
        throw new Error("kv unavailable");
      },
    } as unknown as KVNamespace;
    const { env, workflow } = fixture({ configKv });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const body = await deliver(env, prPayload, "pull_request");
      expect(body.dispatched.map((d) => d.run)).toEqual(
        expect.arrayContaining(["check", "offload-test"]),
      );
      expect(body.skipped).toBeUndefined();
      expect(createdRuns(workflow)).toEqual(expect.arrayContaining(["check", "offload-test"]));
    } finally {
      console.error = original;
    }
    expect(errors.some((e) => e.includes("opt-in read failed") && e.includes('run="check"'))).toBe(
      true,
    );
  });

  it("a deploy without CONFIG_KV dispatches as before", async () => {
    const { env } = fixture();
    const body = await deliver(env, prPayload, "pull_request");
    expect(body.dispatched.map((d) => d.run)).toEqual(
      expect.arrayContaining(["check", "offload-test"]),
    );
    expect(body.skipped).toBeUndefined();
  });
});

