// FlareDispatch Dispatcher — log + executions route tests.
//
// Drives the `handleRequest` router with a hand-built `Request` + fake Env
// (test-helpers.ts), exercising the capability-token gate, the NDJSON / text
// log formats, the aggregate roll-up, the ADMIN_TOKEN listing gate, and the
// HTML viewer's CSP. Same Vitest-2-only pattern as index.test.ts.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { signLogToken } from "../log-token";
import { isHousekeeping, makeNdjsonTextTransform, recordToText } from "./logs";
import { makeFakeD1, makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";

const SECRET = "log-secret-please-rotate";
const ORIGIN = "https://dispatcher.example";
const EXEC = "offload-test:owner_repo:abc123def456";
// Durable check processes: DONE is finalized (consolidated log beside its
// chunks), LIVE is still running (chunks only).
const DONE = `check-check-${"0123456789abcdef".repeat(3)}`;
const LIVE = `check-check-${"fedcba9876543210".repeat(3)}`;

/** An NDJSON exec log body the way `SandboxCloudflareLive.writeLog` writes it. */
const ndjson = (command: string, stdout: string[], stderr: string[] = []): string =>
  [
    JSON.stringify({ stream: "meta", command }),
    ...stdout.map((line) => JSON.stringify({ stream: "stdout", line })),
    ...stderr.map((line) => JSON.stringify({ stream: "stderr", line })),
  ].join("\n") + "\n";

const fixture = (opts: { adminToken?: string } = {}) => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const metadata = makeFakeD1({
    executions: [
      {
        id: EXEC,
        run: "offload-test",
        repo: "owner/repo",
        ref: "refs/heads/main",
        sha: "abc123def456789",
        status: "success",
        started_at: 1000,
        completed_at: 2000,
        parent_execution_id: null,
        input_json: JSON.stringify({ secret: "should-not-leak" }),
        summary_json: JSON.stringify({ ok: true }),
        check_run_id: null,
      },
    ],
    steps: [
      {
        id: `${EXEC}:checkout:1`,
        execution_id: EXEC,
        name: "checkout",
        status: "success",
        started_at: 1000,
        completed_at: 1100,
        exit_code: 0,
        log_uri: null,
        attempt: 1,
      },
    ],
  });
  storage.put(
    `logs/${EXEC}/exec.ndjson`,
    ndjson("pnpm test", ["building…", "ok"], ["a warning"]),
    "application/x-ndjson",
  );
  storage.put(
    `logs/${EXEC}/exec-2.ndjson`,
    ndjson("pnpm build", ["bundle done"]),
    "application/x-ndjson",
  );
  storage.put(`logs/${EXEC}/${DONE}/stdout-0-4.ndjson`, ndjson("pnpm check", ["one"]));
  storage.put(`logs/${EXEC}/${DONE}/stderr-0-10139.ndjson`, ndjson("pnpm check", [], ["two"]));
  storage.put(
    `logs/${EXEC}/${DONE}.ndjson`,
    ndjson("pnpm check", ["one"]) + ndjson("pnpm check", [], ["two"]),
    "application/x-ndjson",
  );
  // Written in stream order; R2 lists them lexically (stderr first, and
  // `stdout-65536-…` before `stdout-9000-…`).
  storage.put(`logs/${EXEC}/${LIVE}/stdout-0-9000.ndjson`, ndjson("pnpm long", ["L1"]));
  storage.put(`logs/${EXEC}/${LIVE}/stderr-0-10139.ndjson`, ndjson("pnpm long", [], ["L2"]));
  storage.put(`logs/${EXEC}/${LIVE}/stdout-9000-65536.ndjson`, ndjson("pnpm long", ["L3"]));
  storage.put(`logs/${EXEC}/${LIVE}/stdout-65536-70000.ndjson`, ndjson("pnpm long", ["L4"]));
  storage.put(`logs/${EXEC}/not-a-log.txt`, "x");
  // A produced-file artifact (what a run `artifact.upload`s) so the detail
  // route surfaces it for the viewer's artifacts strip.
  storage.put(`artifacts/${EXEC}/pr-review.diff`, "diff --git a b\n", "text/plain");
  const env = makeFakeEnv({
    hmacSecret: "h",
    workflow,
    storage,
    metadata,
    logLinkSecret: SECRET,
    publicOrigin: ORIGIN,
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
  });
  return { env };
};

const get = (
  env: ReturnType<typeof fixture>["env"],
  path: string,
  headers?: Record<string, string>,
) => handleRequest(new Request(`${ORIGIN}${path}`, { headers }), env);

describe("NDJSON → text", () => {
  it("maps records to lines", () => {
    expect(recordToText({ stream: "meta", command: "pnpm test" })).toBe("$ pnpm test\n");
    expect(recordToText({ stream: "stdout", line: "hi" })).toBe("hi\n");
    expect(recordToText({ stream: "stderr", line: "boom" })).toBe("[stderr] boom\n");
    expect(recordToText({ stream: "other" })).toBe(null);
  });

  it("transforms a streamed NDJSON body across chunk boundaries", async () => {
    const body = ndjson("echo", ["one", "two"], ["err"]);
    // Split mid-line to exercise the line buffer.
    const mid = Math.floor(body.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(body.slice(0, mid)));
        c.enqueue(enc.encode(body.slice(mid)));
        c.close();
      },
    });
    const out = await new Response(stream.pipeThrough(makeNdjsonTextTransform())).text();
    expect(out).toBe("$ echo\none\ntwo\n[stderr] err\n");
  });
});

describe("isHousekeeping — section noise classifier", () => {
  // The demo runner emits dozens of polling probes per run; these must collapse
  // so the few signal records surface. Cases are drawn from a real product-demo
  // run's exec logs.
  it("treats a `.done`/`.err`/`.out` probe with only a DONE sentinel as housekeeping", () => {
    expect(isHousekeeping("cat /tmp/demo/play-0.done 2>/dev/null || true", ["DONE:0"])).toBe(true);
    expect(isHousekeeping("cat /tmp/demo/record-start-3.done 2>/dev/null || true", [])).toBe(true);
    expect(isHousekeeping("cat /tmp/demo/play-0.err 2>/dev/null || true", [])).toBe(true);
  });

  it("treats pure setup/teardown commands as housekeeping", () => {
    expect(
      isHousekeeping(
        "pkill -9 -f 'demo-agent (play|record)' 2>/dev/null; mkdir -p /tmp/demo/screenshots; true",
        [],
      ),
    ).toBe(true);
    expect(
      isHousekeeping(
        "mkdir -p /tmp/demo/screenshots; demo-agent --help >/dev/null 2>&1 || true",
        [],
      ),
    ).toBe(true);
  });

  it("keeps any section that produced real output", () => {
    // The chapter narrative — the whole point of the run.
    expect(
      isHousekeeping("cat /tmp/demo/play-0.out 2>/dev/null || true", [
        '{"status":"failed","narrative":"…"}',
      ]),
    ).toBe(false);
    // A gif/write command that reports a result.
    expect(
      isHousekeeping("demo-agent gif --out /tmp/demo/demo.gif", [
        '{"gifPath":"/tmp/demo/demo.gif","bytes":85029}',
      ]),
    ).toBe(false);
    // A real test command with normal output is never housekeeping.
    expect(isHousekeeping("pnpm test", ["building…", "ok"])).toBe(false);
  });

  it("does not over-match: a non-probe command with no output is kept", () => {
    // e.g. `demo-agent write-prior --data '<summary table>'` produces no stdout
    // but is the only place the summary text appears — keep it.
    expect(
      isHousekeeping(
        "demo-agent write-prior --out /tmp/demo/summary.md --data '# product-demo'",
        [],
      ),
    ).toBe(false);
  });
});

describe("log routes — token gate", () => {
  it("403s without a token", async () => {
    const { env } = fixture();
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson`);
    expect(res.status).toBe(403);
  });

  it("403s with a wrong token", async () => {
    const { env } = fixture();
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=0000000000000000000000`,
    );
    expect(res.status).toBe(403);
  });

  it("400s on a malformed execution id", async () => {
    const { env } = fixture();
    const res = await get(env, `/v1/executions/a%20b/logs/exec.ndjson?t=x`);
    expect(res.status).toBe(400);
  });

  it("serves the raw NDJSON with a valid token + nosniff", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=${t}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("immutable"); // terminal
  });

  it("serves ?format=text rendered output", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=${t}&format=text`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("$ pnpm test\nbuilding…\nok\n[stderr] a warning\n");
  });

  it("404s a non-existent but well-formed log file", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec-9.ndjson?t=${t}`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a log file name that is not an exec log", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/secrets.env?t=${t}`,
    );
    expect(res.status).toBe(400);
  });

  it("aggregates all exec logs in order", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs?t=${t}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.indexOf("exec.ndjson")).toBeLessThan(text.indexOf("exec-2.ndjson"));
    expect(text).toContain("$ pnpm build");
  });
});

describe("log routes — check-command log names", () => {
  const file = async (name: string, query = "") => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    return get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/${name}?t=${t}${query}`);
  };

  it("serves a consolidated check log", async () => {
    const res = await file(`${DONE}.ndjson`, "&format=text");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("$ pnpm check\none\n$ pnpm check\n[stderr] two\n");
  });

  it("serves a durable chunk addressed the way the listing links it", async () => {
    const res = await file(encodeURIComponent(`${DONE}/stderr-0-10139.ndjson`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toContain('"line":"two"');
  });

  it("serves a durable chunk addressed with a literal slash", async () => {
    const res = await file(`${DONE}/stderr-0-10139.ndjson`, "&format=text");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("$ pnpm check\n[stderr] two\n");
  });

  it.each([
    "not-a-log.txt",
    `${DONE}%2F..%2F..%2Fexec.ndjson`,
    `..%2F..%2Fartifacts%2F${encodeURIComponent(EXEC)}%2Fpr-review.diff`,
    `%2F${DONE}.ndjson`,
    `${DONE}%5Cstderr-0-10139.ndjson`,
    `${DONE}%2F%2Fstderr-0-10139.ndjson`,
    `${DONE}/stdin-0-1.ndjson`,
  ])("refuses %s", async (name) => {
    const res = await file(name);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_log_file");
  });

  it("aggregates each process once, its chunks in stream order", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs?t=${t}`);
    const text = await res.text();
    expect(text).toContain(`===== ${DONE}.ndjson =====`);
    expect(text).not.toContain(`${DONE}/`);
    expect(text).not.toContain("not-a-log.txt");
    const order = ["exec.ndjson", "exec-2.ndjson", `${DONE}.ndjson`, "L1", "L2", "L3", "L4"];
    const at = order.map((needle) => text.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("indexes sections the viewer renders, each file linked", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}?t=${t}`);
    const body = (await res.json()) as {
      sections: { id: string; size: number; files: { file: string; url: string }[] }[];
    };
    expect(body.sections.map((s) => s.id)).toEqual(["exec.ndjson", "exec-2.ndjson", DONE, LIVE]);
    const live = body.sections[3]!;
    expect(live.files.map((f) => f.file)).toEqual([
      `${LIVE}/stdout-0-9000.ndjson`,
      `${LIVE}/stderr-0-10139.ndjson`,
      `${LIVE}/stdout-9000-65536.ndjson`,
      `${LIVE}/stdout-65536-70000.ndjson`,
    ]);
    expect(live.size).toBeGreaterThan(0);
    for (const f of live.files) {
      const served = await get(env, f.url);
      expect(served.status).toBe(200);
    }
  });
});

describe("GET /v1/executions/:id", () => {
  it("returns steps + log index but never input_json", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
    expect((body.steps as unknown[]).length).toBe(1);
    expect((body.logs as { file: string }[]).map((l) => l.file)).toContain("exec.ndjson");
    expect(body.summary).toEqual({ ok: true });
    const arts = body.artifacts as { name: string; url: string; size: number }[];
    expect(arts.map((a) => a.name)).toContain("pr-review.diff");
    const diff = arts.find((a) => a.name === "pr-review.diff")!;
    expect(diff.url).toContain("/v1/artifacts/");
    // Size travels with each artifact so the viewer can label it and guard
    // large inline previews.
    expect(diff.size).toBeGreaterThan(0);
  });

  it("404s an unknown execution (with a valid-shape token)", async () => {
    const { env } = fixture();
    const id = "missing:owner_repo:000000000000";
    const t = await signLogToken(SECRET, id);
    const res = await get(env, `/v1/executions/${encodeURIComponent(id)}?t=${t}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/executions (listing)", () => {
  it("503s when ADMIN_TOKEN is unset", async () => {
    const { env } = fixture();
    expect((await get(env, `/v1/executions`)).status).toBe(503);
  });

  it("401s with a bad bearer", async () => {
    const { env } = fixture({ adminToken: "admin-secret" });
    const res = await get(env, `/v1/executions`, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("lists executions with the bearer, attaching tokened logsUrl", async () => {
    const { env } = fixture({ adminToken: "admin-secret" });
    const res = await get(env, `/v1/executions?run=offload-test`, {
      Authorization: "Bearer admin-secret",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executions: { id: string; logsUrl?: string }[] };
    expect(body.executions[0]!.id).toBe(EXEC);
    expect(body.executions[0]!.logsUrl).toContain("/logs/");
    expect(body.executions[0]!.logsUrl).toContain("?t=");
  });
});

describe("GET /logs/:execution (viewer)", () => {
  it("serves HTML with a strict CSP under a valid token", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/logs/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // Renders the D1 step timeline + run summary (not just log files), so a
    // mostly-Worker-side run (e.g. pr-review) still shows its shape + verdict.
    const html = await res.text();
    expect(html).toContain('id="steps"');
    expect(html).toContain('id="summary"');
    expect(html).toContain('id="artifacts"');
    expect(html).toContain("renderSteps");
    expect(html).toContain("renderSummary");
    expect(html).toContain("renderArtifacts");
    // Steps render as a flame chart / waterfall (bars sized by duration), not
    // equal-width chips.
    expect(html).toContain('id="steps" class="flame"');
    // Artifacts open inline in a GitHub-style file viewer, with a raw
    // open-in-new-tab link alongside.
    expect(html).toContain("openArtifact");
    expect(html).toContain('id="artview"');
    expect(html).toContain("art-raw");
    // Artifacts render as a scrollable rows list (one file per row), not a
    // wrapping chip strip.
    expect(html).toContain("arts-list");
    expect(html).toContain("overflow:auto");
    // Sections are titled by the command (not the meaningless exec-N.ndjson),
    // and internal probe/setup noise collapses behind a housekeeping toggle.
    expect(html).toContain('id="showHousekeeping"');
    expect(html).toContain("isHousekeeping");
    expect(html).toContain("show-housekeeping");
    // The classifier is inlined verbatim from the shared module, not re-typed.
    expect(html).toContain("var isHousekeeping = ");
    // Sections come from the detail index, so a chunked check process renders
    // as one section read file by file.
    expect(html).toContain("detail.sections");
  });

  it("403s the viewer without a token", async () => {
    const { env } = fixture();
    const res = await get(env, `/logs/${encodeURIComponent(EXEC)}`);
    expect(res.status).toBe(403);
  });
});

// The router's Cloudflare-Access gate (access-auth.ts) runs AHEAD of the token
// gate on every viewer surface, and is enforced by default. These cover the
// wiring: which paths the gate fronts (and which it must NOT), in the
// default-secure "required" mode with no Access configured (→ 503).
describe("router viewer-Access gate (default-secure)", () => {
  const requiredEnv = () => {
    const { env } = fixture({ adminToken: "admin-tok" });
    return { ...env, VIEWER_ACCESS_MODE: "required" } as typeof env;
  };
  const t = async () => signLogToken(SECRET, EXEC);

  it.each([
    ["/logs", async () => `/logs/${encodeURIComponent(EXEC)}?t=${await t()}`],
    ["/demos", async () => `/demos/${encodeURIComponent(EXEC)}?t=${await t()}`],
    ["/replay", async () => `/replay/${"a".repeat(16)}`],
    ["/v1/executions", async () => `/v1/executions`],
    ["/v1/executions/:id", async () => `/v1/executions/${encodeURIComponent(EXEC)}?t=${await t()}`],
    [
      "/v1/executions/:id/logs",
      async () => `/v1/executions/${encodeURIComponent(EXEC)}/logs?t=${await t()}`,
    ],
  ])("503 access_not_configured on the viewer surface %s", async (_label, path) => {
    const res = await get(requiredEnv(), await path());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "access_not_configured" });
  });

  it("does NOT gate /v1/artifacts (curated media, embedded in GitHub check-runs)", async () => {
    // Even in required mode the artifact surface is reachable — it streams the
    // stored object directly, never the Access 503.
    const res = await get(
      requiredEnv(),
      `/v1/artifacts/${encodeURIComponent(EXEC)}/pr-review.diff`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("diff --git");
  });

  it("does NOT gate GET /health", async () => {
    const res = await get(requiredEnv(), "/health");
    expect(res.status).toBe(200);
  });

  it("does NOT gate the public OIDC well-known (reaches its own handler, not the Access 503)", async () => {
    // OIDC isn't configured in this fixture, so the handler itself 503s — the
    // point is the body is NOT the Access gate's access_not_configured error.
    const res = await get(requiredEnv(), "/.well-known/openid-configuration");
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("access_not_configured");
  });

  it("does NOT gate POST /v1/dispatch (HMAC surface) — reaches its own 401, not the Access 503", async () => {
    const res = await handleRequest(
      new Request(`${ORIGIN}/v1/dispatch/offload-test`, { method: "POST", body: "{}" }),
      requiredEnv(),
    );
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });
});
