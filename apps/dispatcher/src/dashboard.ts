// FlareDispatch Dispatcher — the `GET /` entry-point dashboard (SSR).
//
// A self-contained HTML index of the inspection surface that already lives on
// this Worker: it lists the latest executions and deep-links each to its log
// viewer (`/logs/:id?t=…`) and, for `product-demo` runs, its recorded
// walkthrough (`/demos/:id?t=…`). It is a VIEWER surface — gated behind the same
// Cloudflare Access app as `/logs`, `/demos`, `/replay`, `/v1/executions` — so
// the renderer assumes an already-authenticated operator.
//
// This module is PURE: `renderDashboard` is a string → string template with no
// I/O, so it stays trivially testable (dashboard.test.ts). The route that feeds
// it (query-param parsing, the D1 reads, the Access gate) is wired in http-app.ts.

/** One execution row, pre-resolved with its tokened viewer links. */
export interface DashboardRow {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Wall-time in ms (`completedAt - startedAt`), or `null` while running. */
  readonly durationMs: number | null;
  /** Per-execution cost rollup in integer micro-USD, or `null` if not computed. */
  readonly costMicroUsd: number | null;
  /** How the cost was derived — `metered | mixed | modeled | unmetered` (null if absent). */
  readonly costBasis: string | null;
  /** Tokened `/logs` URL, or `null` when no log-link secret is configured. */
  readonly logsUrl: string | null;
  /** Tokened `/demos` URL — only set for `product-demo` runs. */
  readonly demosUrl: string | null;
  /**
   * GitHub PR-search URL for this repo's self-heal fix PRs, set ONLY when this
   * execution is a `self-heal-pr` run that opened a verified fix PR (its
   * `summary_json.prStaged === true`). Drives the "self-heal" tag in the viewer
   * — a non-null value means flare-dispatch drove a PR to fix a bug here.
   */
  readonly selfHealPrUrl: string | null;
}

export interface DashboardData {
  /** The dispatcher's public origin (no trailing slash), for canonical/OG. */
  readonly origin: string;
  readonly rows: readonly DashboardRow[];
  /** The active `run`/`repo`/`status` filters (absent keys = unfiltered). */
  readonly filters: DashboardFilters;
  /** Keyset-pagination state for the pager links. */
  readonly pagination: DashboardPagination;
  /** Wall clock for relative timestamps (injected for deterministic tests). */
  readonly nowMs: number;
  /** `owner/repo` slug for the source link. */
  readonly repoSlug: string;
  /** The spend guard's month-to-date line (`GET /api/spend`); absent when unreadable. */
  readonly spendLine?: string;
}

/** Server-side filters, parsed from the `run`/`repo`/`status` query params. */
export interface DashboardFilters {
  readonly run?: string;
  readonly repo?: string;
  readonly status?: string;
}

/**
 * Keyset-pagination state, fully resolved by the caller so the renderer stays
 * pure. Rows are newest-first, so "Older" moves forward in time and "Newer"
 * back toward the top of the list.
 */
export interface DashboardPagination {
  /** Page size the caller applied. */
  readonly limit: number;
  /**
   * Lower bound of THIS page — the `started_at` (and `beforeId`) the page was
   * fetched with. Absent on the first page.
   */
  readonly before?: number;
  /** Same-ms tiebreak id for `before`. */
  readonly beforeId?: string;
  /**
   * Lower bound of the PREVIOUS page, carried through the URL so the "Newer"
   * link can round-trip without a backward cursor query. Absent on page two
   * and earlier (its "Newer" target is the unfettered first page).
   */
  readonly prevBefore?: number;
  readonly prevBeforeId?: string;
  /** True when an older page exists (the caller probed with `limit + 1`). */
  readonly hasMore: boolean;
  /** `started_at` of the last row on this page — the "Older" cursor. */
  readonly nextBefore: number | null;
  readonly nextBeforeId: string | null;
}

/** The status values the filter select offers (known execution states). */
const STATUS_OPTIONS = [
  "success",
  "failure",
  "cancelled",
  "running",
  "started",
  "skipped",
  "queued",
] as const;

/** True iff any filter is active. */
const hasFilters = (f: DashboardFilters): boolean =>
  f.run !== undefined || f.repo !== undefined || f.status !== undefined;

/** Build a same-origin link carrying the given query params. */
const qs = (pairs: ReadonlyArray<readonly [string, string]>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.set(k, v);
  const s = sp.toString();
  return s === "" ? "/" : `/?${s}`;
};

/** The filter params shared by every pager link. */
const filterPairs = (f: DashboardFilters): ReadonlyArray<readonly [string, string]> => {
  const out: [string, string][] = [];
  if (f.run !== undefined) out.push(["run", f.run]);
  if (f.repo !== undefined) out.push(["repo", f.repo]);
  if (f.status !== undefined) out.push(["status", f.status]);
  return out;
};

/** A `before`/`beforeId` cursor pair, omitting the tiebreak when absent. */
const cursorPairs = (
  before: number,
  beforeId: string | null | undefined,
): ReadonlyArray<readonly [string, string]> =>
  beforeId === undefined || beforeId === null
    ? [["before", String(before)]]
    : [
        ["before", String(before)],
        ["beforeId", beforeId],
      ];

/** THIS page's bound, replayed as `prevBefore` for the next hop back. */
const prevCursorPairs = (p: DashboardPagination): ReadonlyArray<readonly [string, string]> =>
  p.before === undefined
    ? []
    : [
        ["prevBefore", String(p.before)],
        ...(p.beforeId !== undefined ? [["prevBeforeId", p.beforeId] as const] : []),
      ];

/** HTML-escape a value for safe interpolation into element text / attributes. */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Map an execution status onto a badge CSS modifier. */
const badgeClass = (status: string): string => {
  switch (status) {
    case "success":
      return "ok";
    case "failure":
      return "fail";
    case "cancelled":
      return "muted";
    case "running":
    case "started":
      return "live";
    default:
      return "pending";
  }
};

/** Compact relative time, e.g. "3m ago", "2h ago", "—" when unknown. */
const relativeTime = (atMs: number | null, nowMs: number): string => {
  if (atMs === null) return "—";
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.round(deltaM / 60);
  if (deltaH < 48) return `${deltaH}h ago`;
  return `${Math.round(deltaH / 24)}d ago`;
};

/** Short 7-char sha for display. */
const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #e7e9ee; background: #0d1017; max-width: 64rem; margin-inline: auto;
  }
  a { color: #6ea8fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem; margin-bottom: .25rem; }
  h1 { font-size: 1.4rem; margin: 0; letter-spacing: -0.01em; }
  .tagline { color: #9aa3b2; margin: 0 0 1.75rem; }
  .spend { color: #9aa3b2; margin: -1.25rem 0 1.75rem; font-size: 0.9rem; }
  h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin: 2rem 0 .6rem; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: #9aa3b2; padding: .4rem .5rem; border-bottom: 1px solid #232838; }
  td { padding: .55rem .5rem; border-bottom: 1px solid #171b27; vertical-align: baseline; }
  tr:hover td { background: #11151f; }
  .run { font-weight: 600; }
  .repo { color: #c4cad6; }
  .sha { color: #8a93a5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .when { color: #8a93a5; white-space: nowrap; }
  .links a { margin-right: .75rem; }
  /* A clickable execution row deep-links to its log viewer. The run cell's link
     carries a stretched ::after that turns the whole <tr> into the hit target,
     while the explicit View links are lifted above it so they stay clickable. */
  tr.rowlink { position: relative; cursor: pointer; }
  .run a { color: inherit; font-weight: inherit; }
  .run a::after { content: ""; position: absolute; inset: 0; }
  .links a { position: relative; z-index: 1; }
  .badge {
    display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 1px solid transparent;
  }
  .badge.ok { color: #7ee2a8; background: #0f2a1c; border-color: #1c5238; }
  .badge.fail { color: #ff9a9a; background: #2c1518; border-color: #5a2730; }
  .badge.live { color: #8fc2ff; background: #102036; border-color: #234a78; }
  .badge.muted { color: #9aa3b2; background: #1a1e29; border-color: #2b313f; }
  .badge.pending { color: #e4c779; background: #2a2412; border-color: #59491c; }
  /* The self-heal tag: a clickable pill (lifted above the row stretch) that
     deep-links to the repo's flare-dispatch fix PRs. */
  .badge.selfheal { color: #c9b3ff; background: #1d1730; border-color: #3b2d63; position: relative; z-index: 1; margin-left: .45rem; }
  .badge.selfheal:hover { text-decoration: none; border-color: #5a47a0; }
  .empty { color: #9aa3b2; padding: 1.5rem .5rem; border: 1px dashed #2b313f; border-radius: .5rem; text-align: center; }
  form.filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: 1rem; }
  form.filters input, form.filters select, form.filters button {
    font: inherit; color: #e7e9ee; background: #11151f; border: 1px solid #2b313f;
    border-radius: .35rem; padding: .35rem .55rem; font-size: 13.5px;
  }
  form.filters button { background: #1c3a5f; border-color: #2b4a75; cursor: pointer; }
  form.filters button:hover { background: #234a78; }
  form.filters .clear { margin-left: .25rem; }
  nav.pager { display: flex; gap: 1.25rem; margin-top: 1rem; font-size: 14px; }
  nav.pager a { white-space: nowrap; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #171b27; color: #8a93a5; font-size: 13px; }
  footer a { margin-right: 1rem; }
`;

const renderRow = (row: DashboardRow, nowMs: number): string => {
  const links: string[] = [];
  if (row.logsUrl !== null) {
    links.push(`<a href="${esc(row.logsUrl)}">Logs</a>`);
  }
  if (row.demosUrl !== null) {
    links.push(`<a href="${esc(row.demosUrl)}">Demo</a>`);
  }
  const linkCell = links.length > 0 ? links.join("") : '<span class="when">—</span>';
  // The run name is the row's primary deep-link: clicking the execution opens
  // its log viewer. When no log link exists (no secret configured) the row is
  // plain text and not click-through.
  const clickable = row.logsUrl !== null;
  const runCell = clickable
    ? `<a href="${esc(row.logsUrl as string)}" title="View logs">${esc(row.run)}</a>`
    : esc(row.run);
  // Self-heal tag — a pill linking to the repo's fix PRs, shown only when this
  // execution actually drove a PR to fix a bug.
  const selfHealPill =
    row.selfHealPrUrl !== null
      ? ` <a class="badge selfheal" href="${esc(row.selfHealPrUrl)}" title="View flare-dispatch self-heal fix PRs">🩹 self-heal</a>`
      : "";
  return `<tr${clickable ? ' class="rowlink"' : ""}>
    <td><span class="badge ${badgeClass(row.status)}">${esc(row.status)}</span></td>
    <td class="run">${runCell}${selfHealPill}</td>
    <td><span class="repo">${esc(row.repo)}</span> <span class="sha">${esc(shortSha(row.sha))}</span></td>
    <td class="when">${esc(relativeTime(row.startedAt, nowMs))}</td>
    <td class="links">${linkCell}</td>
  </tr>`;
};

/**
 * The filter form. A GET form whose named fields carry only the filters — the
 * cursor params are intentionally NOT named fields, so submitting drops them
 * and starts a fresh first page. Values are echoed (escaped) so the active
 * filters survive a page reload.
 */
const renderFilters = (filters: DashboardFilters): string => {
  const options = [
    '<option value="">Any status</option>',
    ...STATUS_OPTIONS.map(
      (s) => `<option value="${s}"${filters.status === s ? " selected" : ""}>${s}</option>`,
    ),
  ].join("\n");
  const clear = hasFilters(filters) ? ` <a href="/" class="clear">Clear filters</a>` : "";
  return `<form class="filters" method="get" action="/">
  <input type="text" name="run" value="${esc(filters.run ?? "")}" placeholder="Run" aria-label="Filter by run" />
  <input type="text" name="repo" value="${esc(filters.repo ?? "")}" placeholder="Repo" aria-label="Filter by repo" />
  <select name="status" aria-label="Filter by status">
${options}
  </select>
  <button type="submit">Filter</button>${clear}
</form>`;
};

/**
 * The keyset pager. "Older" uses the caller's `nextBefore` probe; "Newer"
 * replays the previous page's `before` (carried in the URL as `prevBefore`),
 * which needs no extra query. "First" resets to the unfettered first page.
 */
const renderPager = (filters: DashboardFilters, p: DashboardPagination): string => {
  // Filters + page size ride along on every pager link.
  const base = [...filterPairs(filters), ["limit", String(p.limit)] as const];
  const links: string[] = [];
  if (p.before !== undefined) {
    links.push(`<a href="${esc(qs(base))}">← First</a>`);
    const newer =
      p.prevBefore !== undefined
        ? qs([...base, ...cursorPairs(p.prevBefore, p.prevBeforeId)])
        : qs(base);
    links.push(`<a href="${esc(newer)}">← Newer</a>`);
  }
  if (p.hasMore && p.nextBefore !== null) {
    const older = qs([
      ...base,
      ...cursorPairs(p.nextBefore, p.nextBeforeId),
      // Replay THIS page's bound as `prevBefore` so the next "Newer" link
      // (which carries it back) can return here without a backward query.
      ...prevCursorPairs(p),
    ]);
    links.push(`<a href="${esc(older)}">Older →</a>`);
  }
  if (links.length === 0) return "";
  return `<nav class="pager">${links.join("")}</nav>`;
};

const renderTable = (data: DashboardData): string => {
  if (data.rows.length === 0) {
    const body = hasFilters(data.filters)
      ? `No executions match the current filters. <a href="/">Clear filters</a>`
      : `No executions yet. Dispatch a run to see it appear here.`;
    return `<p class="empty">${body}</p>`;
  }
  const body = data.rows.map((row) => renderRow(row, data.nowMs)).join("\n");
  return `<table>
    <thead><tr>
      <th>Status</th><th>Run</th><th>Repo</th><th>Started</th><th>View</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
${renderPager(data.filters, data.pagination)}`;
};

/**
 * Render the dashboard page. Pure: all data (rows, tokened URLs, clock) is
 * resolved by the caller and passed in.
 */
export const renderDashboard = (data: DashboardData): string => {
  const canonical = `${data.origin.replace(/\/$/, "")}/`;
  const description =
    "FlareDispatch — dispatch CI/CD runs to Cloudflare and inspect their logs, executions, and recorded product demos.";
  const repoUrl = `https://github.com/${data.repoSlug}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlareDispatch — Dashboard</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="FlareDispatch — Dashboard" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta name="twitter:card" content="summary" />
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>FlareDispatch</h1>
</header>
<p class="tagline">Dispatch CI/CD runs to Cloudflare — inspect logs, executions, and product demos.</p>
${data.spendLine !== undefined ? `<p class="spend">${esc(data.spendLine)}</p>\n` : ""}
<main>
  <h2>Latest executions</h2>
  ${renderFilters(data.filters)}
  ${renderTable(data)}
</main>

<footer>
  <a href="/v1/github/install/new">Install the GitHub App</a>
  <a href="${esc(repoUrl)}">Source</a>
</footer>
</body>
</html>`;
};
