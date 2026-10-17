// Tests for the `GET /` dashboard — the pure renderer plus an end-to-end pass
// through `handleRequest` over the in-memory D1/R2/Workflow fakes.

import { describe, expect, it } from "vitest";

import {
  renderDashboard,
  type DashboardFilters,
  type DashboardPagination,
  type DashboardRow,
} from "./dashboard";
import { handleRequest } from "./router";
import { makeFakeD1, makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";

const baseRow = (over: Partial<DashboardRow> = {}): DashboardRow => ({
  id: "offload-test:owner_repo:abc123",
  run: "offload-test",
  repo: "owner/repo",
  ref: "refs/heads/main",
  sha: "abc123def456",
  status: "success",
  startedAt: 1000,
  completedAt: 2000,
  durationMs: 1000,
  costMicroUsd: null,
  costBasis: null,
  logsUrl: null,
  demosUrl: null,
  selfHealPrUrl: null,
  ...over,
});

describe("renderDashboard", () => {
  const data = (
    rows: readonly DashboardRow[],
    over: { filters?: DashboardFilters; pagination?: DashboardPagination } = {},
  ) => ({
    origin: "https://dispatcher.example.com",
    rows,
    filters: over.filters ?? {},
    pagination: over.pagination ?? {
      limit: 20,
      hasMore: false,
      nextBefore: null,
      nextBeforeId: null,
    },
    nowMs: 60_000,
    repoSlug: "fractalbox/flare-dispatch",
  });

  it("renders an empty state when there are no executions", () => {
    const html = renderDashboard(data([]));
    expect(html).toContain("No executions yet");
    expect(html).not.toContain("<tbody>");
  });

  it("renders a row with its run, repo, short sha, and status badge", () => {
    const html = renderDashboard(data([baseRow({ status: "failure" })]));
    expect(html).toContain("offload-test");
    expect(html).toContain("owner/repo");
    expect(html).toContain("abc123d"); // 7-char short sha
    expect(html).toContain('class="badge fail"');
  });

  it("links Logs / Demo only when their tokened URLs are present", () => {
    const html = renderDashboard(
      data([
        baseRow({
          run: "product-demo",
          logsUrl: "https://x/logs/a?t=tok",
          demosUrl: "https://x/demos/a?t=tok",
        }),
      ]),
    );
    expect(html).toContain('href="https://x/logs/a?t=tok"');
    expect(html).toContain('href="https://x/demos/a?t=tok"');
  });

  it("makes the run name a click-through to the log viewer when logs exist", () => {
    const html = renderDashboard(
      data([baseRow({ run: "offload-test", logsUrl: "https://x/logs/a?t=tok" })]),
    );
    expect(html).toContain('class="rowlink"');
    expect(html).toContain('<a href="https://x/logs/a?t=tok" title="View logs">offload-test</a>');
  });

  it("keeps the run name as plain text when no log link is configured", () => {
    const html = renderDashboard(data([baseRow({ run: "offload-test", logsUrl: null })]));
    expect(html).not.toContain('class="rowlink"');
    expect(html).toContain("offload-test");
  });

  it("renders the self-heal tag linking to the fix PRs when set", () => {
    const html = renderDashboard(
      data([
        baseRow({
          run: "self-heal-pr",
          selfHealPrUrl: "https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal",
        }),
      ]),
    );
    expect(html).toContain("🩹 self-heal");
    expect(html).toContain('class="badge selfheal"');
    expect(html).toContain(
      'href="https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal"',
    );
  });

  it("omits the self-heal tag when no fix PR was opened", () => {
    // The run NAME is "self-heal-pr" (so "self-heal" is present); assert the
    // tag pill itself is absent.
    const html = renderDashboard(data([baseRow({ run: "self-heal-pr", selfHealPrUrl: null })]));
    expect(html).not.toContain("🩹");
    expect(html).not.toContain("badge selfheal");
  });

  it("escapes HTML in execution fields", () => {
    const html = renderDashboard(data([baseRow({ repo: "<script>" })]));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the filter form echoing active values and preselecting status", () => {
    const html = renderDashboard(
      data([baseRow()], {
        filters: { run: "offload-test", repo: "a<b", status: "failure" },
      }),
    );
    expect(html).toContain('name="run" value="offload-test"');
    expect(html).toContain('name="repo" value="a&lt;b"');
    expect(html).toContain('<option value="failure" selected>failure</option>');
    expect(html).toContain("Clear filters");
    // The form's named fields carry only the filters — submitting resets paging.
    expect(html).toContain('<form class="filters" method="get" action="/">');
  });

  it("omits the clear link when no filter is active", () => {
    const html = renderDashboard(data([baseRow()]));
    expect(html).not.toContain("Clear filters");
  });

  it("links the older page with cursor + filters + page size", () => {
    const html = renderDashboard(
      data([baseRow()], {
        filters: { status: "failure" },
        pagination: {
          limit: 20,
          hasMore: true,
          nextBefore: 1000,
          nextBeforeId: "a:b:c",
          before: 5000,
          beforeId: "x:y:z",
          prevBefore: 9000,
          prevBeforeId: "p:q:r",
        },
      }),
    );
    expect(html).toContain(
      'href="/?status=failure&amp;limit=20&amp;before=1000&amp;beforeId=a%3Ab%3Ac&amp;prevBefore=5000&amp;prevBeforeId=x%3Ay%3Az"',
    );
    expect(html).toContain("Older →");
  });

  it("links the newer page via prevBefore and a first-page reset", () => {
    const html = renderDashboard(
      data([baseRow()], {
        filters: { run: "offload-test" },
        pagination: {
          limit: 20,
          hasMore: true,
          nextBefore: 100,
          nextBeforeId: "l",
          before: 5000,
          beforeId: "b5",
          prevBefore: 9000,
          prevBeforeId: "b9",
        },
      }),
    );
    // Newer replays the previous page's cursor.
    expect(html).toContain(
      'href="/?run=offload-test&amp;limit=20&amp;before=9000&amp;beforeId=b9"',
    );
    // First resets to page one with filters kept.
    expect(html).toContain('href="/?run=offload-test&amp;limit=20">← First</a>');
  });

  it("newer from page two targets the bare first page", () => {
    const html = renderDashboard(
      data([baseRow()], {
        pagination: {
          limit: 20,
          hasMore: true,
          nextBefore: 100,
          nextBeforeId: "l",
          before: 5000,
          beforeId: "b5",
        },
      }),
    );
    expect(html).toContain('<a href="/?limit=20">← Newer</a>');
  });

  it("omits the pager on an unfetched first page", () => {
    const html = renderDashboard(data([baseRow()]));
    expect(html).not.toContain('class="pager"');
    expect(html).not.toContain("Older →");
    expect(html).not.toContain("← Newer");
  });

  it("explains a filter-matched empty result and links to clear", () => {
    const html = renderDashboard(data([], { filters: { status: "queued" } }));
    expect(html).toContain("No executions match the current filters");
    expect(html).toContain('<a href="/">Clear filters</a>');
    expect(html).not.toContain("No executions yet");
  });

  it("emits canonical + OG metadata pointing at the origin root", () => {
    const html = renderDashboard(data([]));
    expect(html).toContain('<link rel="canonical" href="https://dispatcher.example.com/" />');
    expect(html).toContain('property="og:title"');
  });
});

describe("GET / — dashboard route", () => {
  const fixture = (executions: Record<string, unknown>[]) => {
    const metadata = makeFakeD1({ executions });
    const env = makeFakeEnv({
      hmacSecret: "dashboard-test-secret",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      publicOrigin: "https://dispatcher.example.com",
    });
    return { env };
  };

  const execRow = (over: Record<string, unknown>) => ({
    id: "offload-test:owner_repo:abc1234",
    run: "offload-test",
    repo: "owner/repo",
    ref: "refs/heads/main",
    sha: "abc1234def567",
    status: "success",
    started_at: 1000,
    completed_at: 2000,
    parent_execution_id: null,
    input_json: "{}",
    summary_json: null,
    check_run_id: null,
    ...over,
  });

  it("returns 200 text/html listing executions with tokened log links", async () => {
    const { env } = fixture([execRow({ id: "a:b:c", run: "offload-test", status: "success" })]);
    const res = await handleRequest(new Request("https://dispatcher.example.com/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("offload-test");
    expect(body).toContain("/logs/a%3Ab%3Ac?t=");
  });

  it("links the product-demo viewer for product-demo runs", async () => {
    const { env } = fixture([execRow({ id: "demo1", run: "product-demo", status: "success" })]);
    const res = await handleRequest(new Request("https://dispatcher.example.com/"), env);
    const body = await res.text();
    expect(body).toContain("/demos/demo1?t=");
  });

  it("filters executions by run/repo/status query params", async () => {
    const { env } = fixture([
      execRow({ id: "a:1", run: "offload-test", status: "success" }),
      execRow({ id: "b:1", run: "pr-review", status: "failure" }),
      execRow({ id: "c:1", run: "offload-test", status: "failure" }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/?status=failure&run=offload-test"),
      env,
    );
    const body = await res.text();
    // Execution ids are URL-encoded in the tokened log links.
    expect(body).toContain("/logs/c%3A1?t=");
    expect(body).not.toContain("/logs/a%3A1?t=");
    expect(body).not.toContain("/logs/b%3A1?t=");
  });

  it("ignores blank filter params", async () => {
    const { env } = fixture([
      execRow({ id: "a:1", run: "offload-test" }),
      execRow({ id: "b:1", run: "pr-review" }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/?run=&status=%20"),
      env,
    );
    const body = await res.text();
    expect(body).toContain("offload-test");
    expect(body).toContain("pr-review");
  });

  it("pages older executions via the before cursor", async () => {
    const { env } = fixture([
      execRow({ id: "r1", started_at: 3000 }),
      execRow({ id: "r2", started_at: 2000 }),
      execRow({ id: "r3", started_at: 1000 }),
    ]);
    const page1 = await handleRequest(new Request("https://dispatcher.example.com/?limit=1"), env);
    const body1 = await page1.text();
    expect(body1).toContain("r1");
    expect(body1).not.toContain("r2");
    expect(body1).toContain("Older →");

    const page2 = await handleRequest(
      new Request("https://dispatcher.example.com/?limit=1&before=3000"),
      env,
    );
    const body2 = await page2.text();
    expect(body2).toContain("r2");
    expect(body2).not.toContain("r1");
    expect(body2).toContain("← First");
  });

  it("paginates same-ms executions with the id tiebreak (no skip)", async () => {
    const { env } = fixture([
      execRow({ id: "a1", started_at: 1000 }),
      execRow({ id: "a2", started_at: 1000 }),
      execRow({ id: "b1", started_at: 500 }),
    ]);
    // Page boundary lands mid-tie at (1000, a2): the same-ms a1 must not vanish.
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/?limit=2&before=1000&beforeId=a2"),
      env,
    );
    const body = await res.text();
    expect(body).toContain("/logs/a1?t=");
    expect(body).toContain("/logs/b1?t=");
    expect(body).not.toContain("/logs/a2?t=");
  });

  it("round-trips the prevBefore cursor chain through the pager links", async () => {
    const { env } = fixture([
      execRow({ id: "r1", started_at: 3000 }),
      execRow({ id: "r2", started_at: 2000 }),
      execRow({ id: "r3", started_at: 1000 }),
    ]);
    const page1 = await handleRequest(new Request("https://dispatcher.example.com/?limit=1"), env);
    const html1 = await page1.text();
    // Page 1's Older link opens page 2 (no prevBefore yet).
    expect(html1).toContain('href="/?limit=1&amp;before=3000&amp;beforeId=r1"');

    const page2 = await handleRequest(
      new Request("https://dispatcher.example.com/?limit=1&before=3000&beforeId=r1"),
      env,
    );
    const html2 = await page2.text();
    expect(html2).toContain("r2");
    // Page 2's Older link replays its own bound as prevBefore for the next hop.
    expect(html2).toContain(
      'href="/?limit=1&amp;before=2000&amp;beforeId=r2&amp;prevBefore=3000&amp;prevBeforeId=r1"',
    );
    // Its Newer link returns to the first page via prevBefore.
    expect(html2).toContain('<a href="/?limit=1">← Newer</a>');

    const page3 = await handleRequest(
      new Request(
        "https://dispatcher.example.com/?limit=1&before=2000&beforeId=r2&prevBefore=3000&prevBeforeId=r1",
      ),
      env,
    );
    const html3 = await page3.text();
    expect(html3).toContain("r3");
    expect(html3).toContain('href="/?limit=1&amp;before=3000&amp;beforeId=r1">← Newer</a>');
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture([]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("403s when Cloudflare Access is required but no identity is present", async () => {
    const metadata = makeFakeD1({ executions: [] });
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      viewerAccessMode: "required",
    });
    // ACCESS_AUD / ACCESS_TEAM_DOMAIN unset under "required" → 503, default-deny.
    const res = await handleRequest(new Request("https://dispatcher.example.com/"), env);
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/dashboard.json — SPA feed", () => {
  const fixture = (executions: Record<string, unknown>[]) => {
    const metadata = makeFakeD1({ executions });
    const env = makeFakeEnv({
      hmacSecret: "dashboard-test-secret",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata,
      publicOrigin: "https://dispatcher.example.com",
    });
    return { env };
  };

  const execRow = (over: Record<string, unknown>) => ({
    id: "offload-test:owner_repo:abc1234",
    run: "offload-test",
    repo: "owner/repo",
    ref: "refs/heads/main",
    sha: "abc1234def567",
    status: "success",
    started_at: 1000,
    completed_at: 2000,
    parent_execution_id: null,
    input_json: "{}",
    summary_json: null,
    check_run_id: null,
    ...over,
  });

  it("returns 200 application/json with rows carrying tokened log links", async () => {
    const { env } = fixture([execRow({ id: "a:b:c", run: "offload-test" })]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      repoSlug: string;
      rows: { id: string; run: string; logsUrl: string | null; selfHealPrUrl: string | null }[];
    };
    expect(body.repoSlug).toBe("fractalbox/flare-dispatch");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe("a:b:c");
    expect(body.rows[0]?.logsUrl).toContain("/logs/a%3Ab%3Ac?t=");
    // A plain offload-test run drove no fix PR — no self-heal tag.
    expect(body.rows[0]?.selfHealPrUrl).toBeNull();
  });

  it("sets selfHealPrUrl for a self-heal-pr run that opened a fix PR (prStaged)", async () => {
    const { env } = fixture([
      execRow({
        id: "heal1",
        run: "self-heal-pr",
        repo: "owner/repo",
        summary_json: JSON.stringify({ incidentId: "ci:owner/repo:abc", prStaged: true }),
      }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json"),
      env,
    );
    const body = (await res.json()) as { rows: { selfHealPrUrl: string | null }[] };
    expect(body.rows[0]?.selfHealPrUrl).toBe(
      "https://github.com/owner/repo/pulls?q=is%3Apr%20label%3Aself-heal",
    );
  });

  it("leaves selfHealPrUrl null for a self-heal-pr run that opened no PR (no-fix)", async () => {
    const { env } = fixture([
      execRow({
        id: "heal2",
        run: "self-heal-pr",
        summary_json: JSON.stringify({ outcome: "no-fix", prStaged: false }),
      }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json"),
      env,
    );
    const body = (await res.json()) as { rows: { selfHealPrUrl: string | null }[] };
    expect(body.rows[0]?.selfHealPrUrl).toBeNull();
  });

  it("echoes filters and pagination, clamping limit", async () => {
    const { env } = fixture([
      execRow({ id: "a:1", run: "offload-test", status: "success", started_at: 2000 }),
      execRow({ id: "b:1", run: "pr-review", status: "failure", started_at: 1000 }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json?limit=999&status=failure"),
      env,
    );
    const body = (await res.json()) as {
      filters: { status: string };
      pagination: {
        limit: number;
        hasMore: boolean;
        nextBefore: number | null;
        nextBeforeId: string | null;
      };
      rows: { id: string }[];
    };
    expect(body.filters.status).toBe("failure");
    expect(body.pagination.limit).toBe(100);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe("b:1");
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.nextBefore).toBeNull();
    expect(body.pagination.nextBeforeId).toBeNull();
  });

  it("reports hasMore and the next-page cursor on a short page", async () => {
    const { env } = fixture([
      execRow({ id: "a:1", started_at: 2000 }),
      execRow({ id: "b:1", started_at: 1000 }),
    ]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json?limit=1"),
      env,
    );
    const body = (await res.json()) as {
      rows: { id: string }[];
      pagination: {
        limit: number;
        hasMore: boolean;
        nextBefore: number;
        nextBeforeId: string;
      };
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe("a:1");
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.hasMore).toBe(true);
    expect(body.pagination.nextBefore).toBe(2000);
    expect(body.pagination.nextBeforeId).toBe("a:1");
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture([]);
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("503s when Cloudflare Access is required but unconfigured (default-deny)", async () => {
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata: makeFakeD1({ executions: [] }),
      viewerAccessMode: "required",
    });
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/v1/dashboard.json"),
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe("app shell routing — gated SPA shell with SSR fallback", () => {
  // A stub Workers Static Assets binding that returns the SPA shell regardless
  // of the requested path (the asset layer's SPA fallback behaviour).
  const fakeAssets = (body: string): Fetcher =>
    ({
      fetch: async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    }) as unknown as Fetcher;

  const base = {
    hmacSecret: "dashboard-test-secret",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    metadata: makeFakeD1({ executions: [] }),
    publicOrigin: "https://dispatcher.example.com",
  };

  it("serves the SPA shell from the asset binding for / when ASSETS is present", async () => {
    const env = makeFakeEnv({
      ...base,
      assets: fakeAssets('<!doctype html><div id="root"></div>'),
    });
    const res = await handleRequest(new Request("https://dispatcher.example.com/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it("gates and serves the shell for /executions/:id (SPA deep-link)", async () => {
    const env = makeFakeEnv({ ...base, assets: fakeAssets("SHELL") });
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/executions/a%3Ab%3Ac"),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SHELL");
  });

  it("503s /executions/:id when Cloudflare Access is required but unconfigured", async () => {
    const env = makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata: makeFakeD1({ executions: [] }),
      viewerAccessMode: "required",
      assets: fakeAssets("SHELL"),
    });
    const res = await handleRequest(
      new Request("https://dispatcher.example.com/executions/x"),
      env,
    );
    expect(res.status).toBe(503);
  });

  it("falls back to the SSR dashboard for / when no asset binding is present", async () => {
    const env = makeFakeEnv({
      ...base,
      metadata: makeFakeD1({
        executions: [
          {
            id: "a:b:c",
            run: "offload-test",
            repo: "owner/repo",
            ref: "refs/heads/main",
            sha: "abc1234def567",
            status: "success",
            started_at: 1000,
            completed_at: 2000,
            parent_execution_id: null,
            input_json: "{}",
            summary_json: null,
            check_run_id: null,
          },
        ],
      }),
    });
    const res = await handleRequest(new Request("https://dispatcher.example.com/"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The SSR marker the SPA shell never contains.
    expect(body).toContain("Latest executions");
    expect(body).toContain("offload-test");
  });
});
