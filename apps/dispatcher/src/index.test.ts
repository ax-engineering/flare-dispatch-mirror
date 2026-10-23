// FlareDispatch Dispatcher — route acceptance tests (PR5).
//
// Drives the `handleRequest` router directly with a hand-built `Request` + a
// fake `Env` (see test-helpers.ts). No `@cloudflare/vitest-pool-workers` — the
// repo is pinned to Vitest 2 and that pool needs Vitest 3. The router is
// imported instead of the default `index.ts` export so the test stays free of
// the `cloudflare:workers` / `@cloudflare/sandbox` runtime imports — `index.ts`
// only wires `handleRequest` into the Worker `fetch` handler.
//
// Covers the specs/04-gha-integration.md § Failure handling contract:
//   invalid HMAC → 401; valid HMAC + bad body → 400 (Schema error inlined);
//   unknown run → 404; valid HMAC + valid body → 202 { executionId }.
// Plus the artifact endpoint (streams the R2 object) and /health.

import { describe, expect, it } from "vitest";
import { checkRunNameFor } from "./check-name";
import { handleRequest } from "./router";
import { fingerprint, sign } from "./hmac";
import { makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";

const HMAC_SECRET = "acceptance-test-secret-please-rotate";

/** A well-formed `offload-test` dispatch body — `04-gha-integration § body`. */
const validBody = {
  run: "offload-test",
  github: {
    repo: "owner/test-repo",
    ref: "refs/heads/main",
    sha: "abc123def456",
    pr_number: 42,
    actor: "octocat",
    installation_id: 99999,
  },
  inputs: {
    repo: "owner/test-repo",
    sha: "abc123def456",
    command: "pnpm test",
  },
  trigger: {},
};

/** Build a POST /v1/dispatch/:run Request, optionally signed. */
const dispatchRequest = async (
  run: string,
  bodyText: string,
  opts: {
    sign?: boolean;
    signWith?: string;
    signature?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Request> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.signature !== undefined) {
    headers["X-FlareDispatch-Signature"] = opts.signature;
  } else if (opts.sign !== false) {
    headers["X-FlareDispatch-Signature"] = await sign(
      opts.signWith ?? HMAC_SECRET,
      new TextEncoder().encode(bodyText),
    );
  }
  if (opts.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }
  return new Request(`https://dispatcher.example/v1/dispatch/${run}`, {
    method: "POST",
    headers,
    body: bodyText,
  });
};

/** Read the `error` field off a JSON error response body. */
const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
};

const fixture = (
  opts: {
    withIdempotencyKv?: boolean;
    throwAlreadyExistsFor?: ReadonlySet<string>;
  } = {},
) => {
  const workflow = makeFakeWorkflow({
    throwAlreadyExistsFor: opts.throwAlreadyExistsFor,
  });
  const storage = makeFakeR2();
  const idempotencyKv = opts.withIdempotencyKv ? makeFakeKv() : undefined;
  const env = makeFakeEnv({
    hmacSecret: HMAC_SECRET,
    workflow,
    storage,
    idempotencyKv: idempotencyKv?.binding,
  });
  return { workflow, storage, idempotencyKv, env };
};

describe("GET /health", () => {
  it("returns 200 with status ok and the registered run names", async () => {
    const { env } = fixture();
    const res = await handleRequest(new Request("https://dispatcher.example/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      runs: [
        "cdp-acceptance",
        "check",
        "ci-triage-pr",
        "contextful-cache-warm",
        "contextful-gate",
        "contextful-measures",
        "contextful-protocol",
        "contextful-release",
        "contextful-release-cell",
        "contextful-release-formula",
        "demo-reel",
        "deploy-smoke",
        "email-otp-login",
        "finops-audit",
        "improve-pr",
        "matrix-fanout",
        "offload-test",
        "org-spec-audit",
        "oxlint",
        "playwright-demo",
        "playwright-e2e",
        "pr-review",
        "product-demo",
        "refresh-fixtures",
        "release-notes",
        "self-heal-pr",
        "spec-drift-pr",
        "triage-issues",
        "triage-prs",
        "vitest-shard",
        "worker-deploy",
      ],
    });
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/health", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/dispatch/:run — HMAC", () => {
  it("invalid HMAC → 401, Workflow never created", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      signWith: "the-wrong-secret",
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("unauthorized");
    expect(workflow.calls).toHaveLength(0);
  });

  it("missing signature header → 401", async () => {
    const { env } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      sign: false,
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
  });

  it("401 body carries `dispatcher_secret_fingerprint` for drift diagnosis (issue #24)", async () => {
    // Locks the diagnostic contract: a 401 always surfaces the dispatcher's
    // own sha256(HMAC_SECRET)[:8] so the caller-side GHA Action can print a
    // matching/non-matching pair. Without this, drift between
    // FLAREDISPATCH_HMAC and HMAC_SECRET is silent and burns operator hours.
    const { env } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      signWith: "the-wrong-secret",
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    const payload = (await res.json()) as {
      error: string;
      message: string;
      dispatcher_secret_fingerprint: string;
    };
    expect(payload.error).toBe("unauthorized");
    expect(payload.dispatcher_secret_fingerprint).toBe(await fingerprint(HMAC_SECRET));
    expect(payload.dispatcher_secret_fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("POST /v1/dispatch/:run — validation", () => {
  it("valid HMAC + body failing the run inputs Schema → 400 with the error inlined", async () => {
    const { env, workflow } = fixture();
    // `repo` is required by offload-test inputs; omit it. (`command` is now
    // optional — webhook mode resolves it from CONFIG_KV — so it is no longer
    // the field that fails validation.)
    const badBody = {
      ...validBody,
      inputs: { sha: "abc123", command: "pnpm test" },
    };
    const bodyText = JSON.stringify(badBody);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; detail: string };
    expect(payload.error).toBe("invalid_inputs");
    // The Schema parse error is inlined and mentions the missing field.
    expect(payload.detail).toContain("repo");
    expect(workflow.calls).toHaveLength(0);
  });

  it("valid HMAC + body failing the envelope Schema → 400", async () => {
    const { env } = fixture();
    // `github.sha` is required by the envelope; drop it. (`installation_id`
    // used to be exercised here, but it is now optional — see the
    // "installation_id is optional" + "installation_id: 0 → 400" tests
    // below.)
    const badEnvelope = {
      run: "offload-test",
      github: { repo: "owner/x", installation_id: 12345 },
      inputs: validBody.inputs,
    };
    const bodyText = JSON.stringify(badEnvelope);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_body");
  });

  it("github.installation_id = 0 → 400 with a clear message", async () => {
    // 0 is the default the GHA Action's `installation-id` input sends when
    // unset. Used to flow through and either die at `getInstallationToken(0)`
    // (App secrets present) or silently no-op the `Checks` Layer (App secrets
    // absent). Reject it at the gate so misconfigured callers see the failure
    // in the GHA log on the very first run.
    const { env, workflow } = fixture();
    const badEnvelope = {
      ...validBody,
      github: { ...validBody.github, installation_id: 0 },
    };
    const bodyText = JSON.stringify(badEnvelope);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; detail: string };
    expect(payload.error).toBe("invalid_body");
    expect(payload.detail).toContain("installation_id");
    expect(payload.detail).toContain("positive");
    expect(workflow.calls).toHaveLength(0);
  });

  it("valid HMAC + non-JSON body → 400", async () => {
    const { env } = fixture();
    const bodyText = "this is not json";
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_body");
  });

  it("valid HMAC against an unknown run → 404", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({ ...validBody, run: "no-such-run" });
    const req = await dispatchRequest("no-such-run", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("run_not_found");
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/dispatch/:run — success", () => {
  it("valid HMAC + valid body → 202 { executionId } with semantic id and creates the Workflow", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    // Semantic instanceId per spec 04-gha § Receiver dedup —
    // `{run}:{repo}:{sha[:12]}`, sanitized to a valid CF Workflows id by
    // `toInstanceId` (disallowed chars — `:` and `/` — become `_`).
    expect(payload.executionId).toBe("offload-test_owner_test-repo_abc123def456");

    expect(workflow.calls).toHaveLength(1);
    const call = workflow.calls[0]!;
    expect(call.id).toBe(payload.executionId);

    // `params` is exactly the DispatchPayload shape RunWorkflow decodes,
    // with installation_id + pr_number carried in `github` for PR6.
    const params = call.params as {
      executionId: string;
      run: string;
      github: Record<string, unknown>;
      inputs: Record<string, unknown>;
    };
    expect(params.executionId).toBe(payload.executionId);
    expect(params.run).toBe("offload-test");
    expect(params.github).toEqual({
      repo: "owner/test-repo",
      ref: "refs/heads/main",
      sha: "abc123def456",
      installation_id: 99999,
      pr_number: 42,
    });
    expect(params.inputs).toMatchObject({
      repo: "owner/test-repo",
      sha: "abc123def456",
      command: "pnpm test",
    });
  });

  it("defaults github.ref when omitted, omits pr_number when absent", async () => {
    const { env, workflow } = fixture();
    const body = {
      run: "offload-test",
      github: {
        repo: "owner/test-repo",
        sha: "abc123def456",
        installation_id: 12345,
      },
      inputs: validBody.inputs,
    };
    const bodyText = JSON.stringify(body);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as {
      github: Record<string, unknown>;
    };
    expect(params.github).toEqual({
      repo: "owner/test-repo",
      ref: "refs/heads/main",
      sha: "abc123def456",
      installation_id: 12345,
    });
    expect("pr_number" in params.github).toBe(false);
  });

  it("installation_id is optional — omitted means 'no check-run', body accepted", async () => {
    // Mirrors the no-op-Checks path in packages/runtime-cf/src/checks-github.ts:
    // omitting installation_id is the right shape for local dev, ad-hoc curl
    // dispatches, or repos where the FlareDispatch App isn't installed yet.
    const { env, workflow } = fixture();
    const body = {
      run: "offload-test",
      github: { repo: "owner/test-repo", sha: "abc123def456" },
      inputs: validBody.inputs,
    };
    const bodyText = JSON.stringify(body);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as {
      github: Record<string, unknown>;
    };
    expect(params.github).toEqual({
      repo: "owner/test-repo",
      ref: "refs/heads/main",
      sha: "abc123def456",
    });
    expect("installation_id" in params.github).toBe(false);
  });

  it("forwards notify.emails into the Workflow params", async () => {
    const { env, workflow } = fixture();
    const body = {
      ...validBody,
      notify: { emails: ["alice@x.com", "bob@y.com"] },
    };
    const bodyText = JSON.stringify(body);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as { notify?: unknown };
    expect(params.notify).toEqual({ emails: ["alice@x.com", "bob@y.com"] });
  });

  it("captures the request origin into the Workflow params", async () => {
    const { env, workflow } = fixture();
    const req = await dispatchRequest("offload-test", JSON.stringify(validBody));
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    // Absolutizes the run's `/v1/artifacts/...` URLs — a relative link in a
    // check-run summary resolves against github.com and 404s.
    const params = workflow.calls[0]!.params as { origin?: string };
    expect(params.origin).toBe("https://dispatcher.example");
  });

  it("prefers PUBLIC_ORIGIN over the request origin when set", async () => {
    const { env, workflow } = fixture();
    const req = await dispatchRequest("offload-test", JSON.stringify(validBody));
    const res = await handleRequest(req, {
      ...env,
      PUBLIC_ORIGIN: "https://fd.example.org",
    });
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as { origin?: string };
    expect(params.origin).toBe("https://fd.example.org");
  });

  it("drops an empty notify.emails (no notify in params)", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({ ...validBody, notify: { emails: [] } });
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as Record<string, unknown>;
    expect("notify" in params).toBe(false);
  });

  it("rejects a malformed notify email with 400", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({
      ...validBody,
      notify: { emails: ["not-an-email"] },
    });
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_body");
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("GET /v1/artifacts/:execution/:name", () => {
  it("streams the stored R2 object body with its content-type", async () => {
    const { env, storage } = fixture();
    const execution = "01JABCDEF0123456789ABCDEFG";
    const ndjson = '{"line":1}\n{"line":2}\n';
    storage.put(`artifacts/${execution}/step.log`, ndjson, "application/x-ndjson");

    const res = await handleRequest(
      new Request(`https://dispatcher.example/v1/artifacts/${execution}/step.log`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await res.text()).toBe(ndjson);
  });

  it("404s when the artifact does not exist", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/v1/artifacts/01MISSING/step.log"),
      env,
    );
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("artifact_not_found");
  });

  it("405s a non-GET method on the artifact path", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/v1/artifacts/01X/step.log", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("GET /v1/artifacts/:execution/:name/... — browse expansion", () => {
  const execution = "01JABCDEF0123456789ABCDEFG";
  const base = `https://dispatcher.example/v1/artifacts/${execution}/acceptance-report`;

  const seeded = () => {
    const f = fixture();
    f.storage.put(`artifacts/${execution}/acceptance-report`, "tarball-bytes", "application/gzip");
    f.storage.put(
      `artifacts/${execution}/acceptance-report/index.html`,
      "<html>report</html>",
      "text/html; charset=utf-8",
    );
    f.storage.put(`artifacts/${execution}/acceptance-report/data/shot.png`, "PNG", "image/png");
    return f;
  };

  it("bare name still streams the tarball (download contract unchanged)", async () => {
    const { env } = seeded();
    const res = await handleRequest(new Request(base), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await res.text()).toBe("tarball-bytes");
  });

  it("serves a nested expanded file with its stored content-type", async () => {
    const { env } = seeded();
    const res = await handleRequest(new Request(`${base}/data/shot.png`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("PNG");
  });

  it("trailing slash serves the bundle's own index.html", async () => {
    const { env } = seeded();
    const res = await handleRequest(new Request(`${base}/`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<html>report</html>");
  });

  it("trailing slash falls back to a directory listing without index.html", async () => {
    const { env, storage } = fixture();
    storage.put(
      `artifacts/${execution}/screenshots/sub/error-context.md`,
      "# ctx",
      "text/plain; charset=utf-8",
    );
    const res = await handleRequest(
      new Request(`https://dispatcher.example/v1/artifacts/${execution}/screenshots/`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("sub/error-context.md");
    expect(html).toContain("download .tar.gz");
  });

  it("404s a browse on an unexpanded artifact with a helpful error", async () => {
    const { env, storage } = fixture();
    storage.put(`artifacts/${execution}/legacy`, "tar", "application/gzip");
    const res = await handleRequest(
      new Request(`https://dispatcher.example/v1/artifacts/${execution}/legacy/`),
      env,
    );
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("artifact_not_browsable");
  });

  it("404s a missing nested path", async () => {
    const { env } = seeded();
    const res = await handleRequest(new Request(`${base}/data/nope.png`), env);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("artifact_not_found");
  });
});

describe("POST /v1/dispatch/:run — dedup", () => {
  it("explicit Idempotency-Key header → executionId equals the header value", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      idempotencyKey: "caller-supplied-key-2026",
    });
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    expect(payload.executionId).toBe("caller-supplied-key-2026");
    expect(workflow.calls).toHaveLength(1);
    expect(workflow.calls[0]!.id).toBe("caller-supplied-key-2026");
  });

  it("second dispatch with same semantic key collapses — one Workflow.create, same executionId", async () => {
    const { env, workflow, idempotencyKv } = fixture({
      withIdempotencyKv: true,
    });
    expect(idempotencyKv).toBeDefined();

    const bodyText = JSON.stringify(validBody);
    const req1 = await dispatchRequest("offload-test", bodyText);
    const res1 = await handleRequest(req1, env);
    expect(res1.status).toBe(202);
    const id1 = ((await res1.json()) as { executionId: string }).executionId;

    const req2 = await dispatchRequest("offload-test", bodyText);
    const res2 = await handleRequest(req2, env);
    expect(res2.status).toBe(202);
    const id2 = ((await res2.json()) as { executionId: string }).executionId;

    expect(id1).toBe(id2);
    // Workflow.create is short-circuited on the second call.
    expect(workflow.calls).toHaveLength(1);
  });

  it("two DIFFERENTLY-LABELLED check dispatches of one commit stay two executions", async () => {
    // A repo with several gates dispatches `check` once per gate against the
    // same commit. If `checkLabel` were left out of the semantic id these would
    // collapse: the first gate runs, every other gate's `flare-dispatch/check:*`
    // check-run never posts, and a branch protection requiring them waits
    // forever on a check that will not arrive.
    const { env, workflow, idempotencyKv } = fixture({
      withIdempotencyKv: true,
    });
    expect(idempotencyKv).toBeDefined();

    const labelled = (checkLabel: string) =>
      JSON.stringify({
        ...validBody,
        run: "check",
        inputs: { repo: "owner/test-repo", sha: "abc123def456", checkLabel },
      });

    const res1 = await handleRequest(await dispatchRequest("check", labelled("codegen")), env);
    const res2 = await handleRequest(await dispatchRequest("check", labelled("lint-shell")), env);
    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    const id1 = ((await res1.json()) as { executionId: string }).executionId;
    const id2 = ((await res2.json()) as { executionId: string }).executionId;
    expect(id1).not.toBe(id2);
    expect(workflow.calls).toHaveLength(2);
  });

  it("the SAME label dispatched twice still collapses — labelling doesn't defeat dedup", async () => {
    const { env, workflow, idempotencyKv } = fixture({
      withIdempotencyKv: true,
    });
    expect(idempotencyKv).toBeDefined();

    const bodyText = JSON.stringify({
      ...validBody,
      run: "check",
      inputs: {
        repo: "owner/test-repo",
        sha: "abc123def456",
        checkLabel: "codegen",
      },
    });

    const res1 = await handleRequest(await dispatchRequest("check", bodyText), env);
    const res2 = await handleRequest(await dispatchRequest("check", bodyText), env);
    const id1 = ((await res1.json()) as { executionId: string }).executionId;
    const id2 = ((await res2.json()) as { executionId: string }).executionId;

    expect(id1).toBe(id2);
    expect(workflow.calls).toHaveLength(1);
  });

  it("an UNLABELLED check dispatch keeps its pre-feature semantic id", async () => {
    // The webhook trigger's idempotencyKey is `check:{repo_}:{sha12}` — an
    // Action-mode unlabelled dispatch of the same commit must still collapse
    // onto it, so the id derivation cannot gain a label segment unconditionally.
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({
      ...validBody,
      run: "check",
      inputs: { repo: "owner/test-repo", sha: "abc123def456" },
    });
    await handleRequest(await dispatchRequest("check", bodyText), env);
    expect(workflow.calls[0]!.id).toBe("check_owner_test-repo_abc123def456");
  });

  it("a labelled worker-deploy dispatch keeps its label through decode — own check-run name, own execution", async () => {
    // A second deploy of one commit (e.g. container Workers after an image
    // build) must not post under the webhook deploy's `flare-dispatch/worker-deploy`.
    // The label reaches the Workflow only if the run's schema declares it —
    // an undeclared key is stripped by the decode, and the check-run would
    // then be named as if unlabelled.
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({
      ...validBody,
      run: "worker-deploy",
      inputs: {
        repo: "owner/test-repo",
        sha: "abc123def456",
        command: "pnpm deploy:containers",
        checkLabel: "containers",
      },
    });
    const res = await handleRequest(await dispatchRequest("worker-deploy", bodyText), env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as { inputs: Record<string, unknown> };
    expect(params.inputs.checkLabel).toBe("containers");
    expect(checkRunNameFor("worker-deploy", params.inputs)).toBe(
      "flare-dispatch/worker-deploy:containers",
    );
    expect(workflow.calls[0]!.id).toBe("worker-deploy_containers_owner_test-repo_abc123def456");
  });

  it("without IDEMPOTENCY_KV bound, semantic id is still used — duplicate Workflow.create is the dedup", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    await handleRequest(await dispatchRequest("offload-test", bodyText), env);
    await handleRequest(await dispatchRequest("offload-test", bodyText), env);
    // Two create calls, both with the same semantic id — CF Workflows
    // rejects the second with `instance.already_exists`, which the
    // dispatcher catches and returns 202 for (covered by the next test
    // — this one only exercises that the id derivation is stable).
    expect(workflow.calls).toHaveLength(2);
    expect(workflow.calls[0]!.id).toBe(workflow.calls[1]!.id);
  });

  it("Workflow.create raising instance.already_exists → 202, no error to caller", async () => {
    const semanticId = "offload-test_owner_test-repo_abc123def456";
    const { env, workflow } = fixture({
      throwAlreadyExistsFor: new Set([semanticId]),
    });
    const bodyText = JSON.stringify(validBody);
    const res = await handleRequest(await dispatchRequest("offload-test", bodyText), env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    expect(payload.executionId).toBe(semanticId);
    // The throwing create attempt is not recorded as a successful call.
    expect(workflow.calls).toHaveLength(0);
  });

  it("Workflow.create raising a non-already_exists error → propagates", async () => {
    const { env } = fixture();
    // Inject a workflow whose create always throws an unrelated error.
    (env as unknown as { RUNS_WORKFLOW: unknown }).RUNS_WORKFLOW = {
      create: async () => {
        throw new Error("internal_storage_unavailable");
      },
    };

    const bodyText = JSON.stringify(validBody);
    await expect(
      handleRequest(await dispatchRequest("offload-test", bodyText), env),
    ).rejects.toThrow(/internal_storage_unavailable/);
  });
});

describe("POST /v1/dispatch/:run — cooldown", () => {
  /** A well-formed `pr-review` dispatch body for the given head sha. */
  const prReviewBody = (sha: string, pr = 7) => ({
    run: "pr-review",
    github: {
      repo: "owner/test-repo",
      ref: "refs/heads/feature",
      sha,
      pr_number: pr,
      actor: "octocat",
      installation_id: 99999,
    },
    inputs: {
      repo: "owner/test-repo",
      sha,
      baseSha: "base000000000000",
      pr,
    },
    trigger: {},
  });

  it("second dispatch for the same PR inside the window → 202 skipped with the prior id", async () => {
    const { env, workflow } = fixture({ withIdempotencyKv: true });

    const res1 = await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("aaaa111122223333"))),
      env,
    );
    expect(res1.status).toBe(202);
    const id1 = ((await res1.json()) as { executionId: string }).executionId;
    expect(workflow.calls).toHaveLength(1);

    // A new push (different sha) on the SAME PR, inside the cooldown window.
    const res2 = await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("bbbb444455556666"))),
      env,
    );
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as {
      executionId: string;
      skipped?: string;
      retryAfterSec?: number;
    };
    expect(body2.skipped).toBe("cooldown");
    expect(body2.executionId).toBe(id1);
    expect(body2.retryAfterSec).toBeGreaterThan(0);
    // No second Workflow.create.
    expect(workflow.calls).toHaveLength(1);
  });

  it("a different PR dispatches normally inside another PR's window", async () => {
    const { env, workflow } = fixture({ withIdempotencyKv: true });
    await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("aaaa111122223333", 7))),
      env,
    );
    const res = await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("cccc777788889999", 8))),
      env,
    );
    expect(res.status).toBe(202);
    expect(((await res.json()) as { skipped?: string }).skipped).toBeUndefined();
    expect(workflow.calls).toHaveLength(2);
  });

  it("without IDEMPOTENCY_KV the cooldown is not enforced (best-effort)", async () => {
    const { env, workflow } = fixture();
    await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("aaaa111122223333"))),
      env,
    );
    await handleRequest(
      await dispatchRequest("pr-review", JSON.stringify(prReviewBody("bbbb444455556666"))),
      env,
    );
    expect(workflow.calls).toHaveLength(2);
  });
});

describe("unmatched routes", () => {
  it("404s an unknown path", async () => {
    const { env } = fixture();
    const res = await handleRequest(new Request("https://dispatcher.example/nope"), env);
    expect(res.status).toBe(404);
  });
});
