// @fractalboxdev/flare-dispatch-github-app — the issue surface: two reads, six writes.
//
//   GET    /repos/{o}/{r}/issues                    — list, carrying labels
//   GET    /repos/{o}/{r}/issues/{n}                — read one, before a bot-issue close
//   POST   /repos/{o}/{r}/issues                    — CREATE one issue
//   POST   /repos/{o}/{r}/issues/{n}/labels         — add labels
//   DELETE /repos/{o}/{r}/issues/{n}/labels/{name}  — remove one label
//   POST   /repos/{o}/{r}/issues/{n}/comments       — comment
//   POST   /repos/{o}/{r}/issues/{n}/assignees      — assign
//   PATCH  /repos/{o}/{r}/issues/{n}                — close AS A DUPLICATE, or close
//                                                     a bot-opened ledger issue AS COMPLETED
//
// Why these and not a general issue API: `process/content/maintenance-loop.md`
// §5 says **labels are the state machine**, and a classifier whose verdict
// cannot be recorded is spend with no artifact. Still no reopen, no edit, no
// milestone, no assignee-clearing — a capability nobody needs is a capability
// waiting to be mis-wired.
//
// --- Why `createIssue` exists now, having deliberately not existed -----------
//
// This module shipped with "no create" as a stated rule, because the triage desk
// only ever *routes* issues other people open. The spec-audit sweep changed what
// an issue is for: it files **one issue per open question**, and that issue is
// the loop's ledger entry rather than a report of anything. The state a decline
// needs — closed, and still closed a year later — is then the artifact itself,
// where the PR-shaped version needed a key, a second file in git, and a cooldown
// dated from a column the org store does not carry.
//
// The narrowness survives the addition. `createIssue` takes a title, a body and
// labels; there is no assignee, no milestone, no template, and no way to spell
// "create in a repo I was not given". What bounds it is the caller: the sweep
// files into ONE control repo it read from config, and it files nothing it did
// not first fail to find in that repo's existing issues.
//
// --- `closeIssueAsDuplicate` is not `closeIssue` ------------------------------
//
// Closing is the one irreversible-ish write here, and §5 authorizes it for
// exactly one verdict: a duplicate, linked to its original. So the function is
// named for that verdict and **requires `duplicateOf`**. There is no way to
// spell "close this issue" without also naming the issue it duplicates, which
// makes "close on a non-duplicate verdict" unrepresentable rather than merely
// forbidden — the reviewer checks a signature instead of auditing call sites.
// The `state_reason: "duplicate"` GitHub records is the same claim, in a form
// GitHub's own UI reads.
//
// `closeBotIssue` is the one other close, and it closes no reporter's issue: it
// reads the issue first and closes it as `completed` only when the authenticated
// App bot opened it and it carries the caller's ledger label. Any other issue
// answers `closed: false` and stays open.
//
// --- The list endpoint returns pull requests too -----------------------------
//
// `GET /issues` is the "issues and PRs" endpoint — every PR is an issue in
// GitHub's data model, and a PR comes back carrying a `pull_request` key. A
// triage pass that skipped that filter would classify pull requests as bugs and
// label them. They are filtered out here, once, rather than at each caller.
//
// --- Author provenance travels with the issue --------------------------------
//
// `author_association` is read and returned because §5 requires it: a repro
// captured from a first-time external reporter and one from a repo member are
// different facts, and "whoever wires the dispatch must be able to tell a repo
// member from a first-time external reporter". Dropping it here would make that
// distinction unavailable to every consumer downstream.
//
// Provider-neutral plain `async`, no Effect — the Layer (`makeGithubLive`) wraps
// these, the same split every other module in this package keeps.

import { GithubApiError } from "./errors";
import { assertOk, API_BASE_DEFAULT, ghHeaders, resolveClient, splitRepo } from "./http";

/** How GitHub describes the author's standing in the repo. */
export type AuthorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR"
  | "FIRST_TIMER"
  | "MANNEQUIN"
  | "NONE";

/** One issue, in the shape the triage desk reads. */
export type IssueListItem = {
  readonly number: number;
  readonly title: string;
  /** Body text. `""` when the reporter left it empty. UNTRUSTED prose. */
  readonly body: string;
  readonly state: "open" | "closed";
  /** Label names, lowercased by GitHub's own casing — used as exact strings. */
  readonly labels: readonly string[];
  readonly author: string;
  /** The author's standing in this repo (§5 — provenance travels with the repro). */
  readonly authorAssociation: AuthorAssociation;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * When the issue was closed, or `""` while it is open.
   *
   * Read because a cooldown needs it and `updatedAt` cannot substitute — any
   * touch resets that one, so a window computed from it never expires. The org
   * store's `pulls` table lacks this column entirely, which is why suppression
   * reads GitHub rather than the store; `issues` has it, so an issue-shaped
   * ledger needs no workaround.
   */
  readonly closedAt: string;
  readonly url: string;
  readonly commentCount: number;
};

const ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

/** GitHub's issue JSON — only the fields consumed. */
type RawIssue = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly user?: { readonly login?: unknown };
  readonly author_association?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  /** `null` while the issue is open. */
  readonly closed_at?: unknown;
  readonly html_url?: unknown;
  readonly comments?: unknown;
  /** Present iff this "issue" is really a pull request. */
  readonly pull_request?: unknown;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Label entries are objects (`{name}`) on the REST list; tolerate bare strings. */
const labelNames = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((l) =>
          typeof l === "string" ? l : str((l as { name?: unknown } | null)?.name ?? undefined),
        )
        .filter((n) => n.length > 0)
    : [];

const normalizeIssue = (raw: RawIssue): IssueListItem | undefined => {
  // A pull request wearing an issue's clothes — see the header.
  if (raw.pull_request !== undefined && raw.pull_request !== null) return undefined;
  if (typeof raw.number !== "number") return undefined;
  const association = str(raw.author_association, "NONE");
  return {
    number: raw.number,
    title: str(raw.title),
    body: str(raw.body),
    state: raw.state === "closed" ? "closed" : "open",
    labels: labelNames(raw.labels),
    author: str(raw.user?.login, "unknown"),
    authorAssociation: (ASSOCIATIONS.has(association) ? association : "NONE") as AuthorAssociation,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    closedAt: str(raw.closed_at),
    url: str(raw.html_url),
    commentCount: typeof raw.comments === "number" ? raw.comments : 0,
  };
};

/** Shared by every call here. */
type IssueCallBase = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type ListIssuesOptions = IssueCallBase & {
  /** Defaults to `open` — the state the triage desk reads. */
  readonly state?: "open" | "closed" | "all";
  /** Restrict to issues carrying every one of these labels. */
  readonly labels?: readonly string[];
  /** Only issues updated at/after this epoch-ms. */
  readonly updatedSince?: number;
  /** Page ceiling — bounds a sweep over a large backlog. Default 5 (500 issues). */
  readonly maxPages?: number;
  /**
   * Throw instead of returning a list the page ceiling cut short.
   *
   * A triage pass wants the default: reading the 500 most recently updated
   * issues is the bound, and a backlog past it is simply not this tick's work.
   * A **deduplication** read cannot live with that. It asks "have I already
   * filed this question?", and a truncated list answers "no" for everything it
   * did not reach — so the caller files a duplicate of every question that fell
   * off the last page, which is the exact failure the read exists to prevent.
   *
   * Two returns are otherwise indistinguishable: the loop stops on a short page
   * (the list is complete) or on the ceiling with a full page (there is more),
   * and a bare array cannot tell them apart. Rather than return a shape every
   * caller must then remember to check, the caller that cannot tolerate a
   * partial read asks for `strict` and gets an error it already handles.
   */
  readonly strict?: boolean;
};

const PER_PAGE = 100;
const MAX_PAGES_DEFAULT = 5;

/**
 * List issues, newest-updated first, with pull requests filtered out.
 *
 * Paginates to `maxPages` and stops early on a short page. The ceiling is a
 * bound on a scheduled sweep, not a correctness property: a backlog past it is
 * simply not read this tick, which is visible rather than silent because the
 * caller knows what it asked for. Callers that need the *whole* set — see
 * `strict` — get an error instead of a short list.
 */
export const listIssues = async (opts: ListIssuesOptions): Promise<IssueListItem[]> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const { owner, name } = splitRepo(opts.repo);
  const maxPages = opts.maxPages ?? MAX_PAGES_DEFAULT;
  const out: IssueListItem[] = [];
  /** Did the pagination end because GitHub ran out, or because we did? */
  let exhausted = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${apiBase ?? API_BASE_DEFAULT}/repos/${owner}/${name}/issues`);
    url.searchParams.set("state", opts.state ?? "open");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    if (opts.labels !== undefined && opts.labels.length > 0) {
      url.searchParams.set("labels", opts.labels.join(","));
    }
    if (opts.updatedSince !== undefined) {
      url.searchParams.set("since", new Date(opts.updatedSince).toISOString());
    }

    const res = await doFetch(url.toString(), { method: "GET", headers: ghHeaders(opts.token) });
    await assertOk(res, `issue list failed for ${opts.repo}`);
    const body = (await res.json()) as RawIssue[];
    if (!Array.isArray(body)) {
      exhausted = true;
      break;
    }
    for (const raw of body) {
      const issue = normalizeIssue(raw);
      if (issue !== undefined) out.push(issue);
    }
    if (body.length < PER_PAGE) {
      exhausted = true;
      break;
    }
  }

  // Status 0 — the same convention `splitRepo` uses for a caller-side fault, so
  // the Effect Layer above maps it without learning a second error type.
  //
  // The message names the remedy because this failure is permanent once reached:
  // a strict caller whose set has outgrown its ceiling fails every tick until
  // someone raises it. That is the intended behaviour — the alternative is a
  // caller silently deciding on a partial list — but a red run that does not say
  // what to change is a red run people learn to ignore.
  if (!exhausted && opts.strict === true) {
    throw new GithubApiError(
      `issue list for ${opts.repo} hit the ${maxPages}-page ceiling (${maxPages * PER_PAGE} ` +
        `issues) with more to read, and a strict caller cannot decide on a partial list — ` +
        `raise \`maxPages\` or narrow the label filter`,
      0,
      "",
    );
  }
  return out;
};

export type CreateIssueOptions = IssueCallBase & {
  readonly title: string;
  readonly body: string;
  /**
   * Labels to apply at creation. GitHub creates a label that does not exist yet,
   * with a default colour — so a caller can bring the state machine's vocabulary
   * into a fresh repo without a setup step, and a typo becomes a stray label
   * rather than a 422.
   */
  readonly labels?: readonly string[];
};

/** A created issue, in the shape a caller needs to announce it. */
export type CreateIssueResult = {
  readonly number: number;
  readonly url: string;
};

/**
 * Open one issue.
 *
 * The response is decoded strictly, unlike the tolerant normalizer above: a
 * create whose `number` did not come back is a write whose result cannot be
 * named, and a caller announcing `#0` or linking nowhere is worse than a caller
 * that failed. The list read tolerates a malformed row because dropping one of
 * five hundred issues costs a tick; there is no equivalent here.
 */
export const createIssue = async (opts: CreateIssueOptions): Promise<CreateIssueResult> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const { owner, name } = splitRepo(opts.repo);
  const res = await doFetch(`${apiBase ?? API_BASE_DEFAULT}/repos/${owner}/${name}/issues`, {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      ...(opts.labels !== undefined && opts.labels.length > 0 ? { labels: opts.labels } : {}),
    }),
  });
  await assertOk(res, `issue create failed for ${opts.repo}`);
  const created = (await res.json()) as { readonly number?: unknown; readonly html_url?: unknown };
  if (typeof created.number !== "number") {
    throw new GithubApiError(
      `issue create for ${opts.repo} returned no issue number`,
      res.status,
      "",
    );
  }
  // The URL is validated too, not just the number: a caller announces this issue
  // by linking it, so `""` would publish a broken link rather than fail. Both
  // fields are checked because both are load-bearing for the same caller.
  const url = str(created.html_url);
  if (url === "") {
    throw new GithubApiError(
      `issue create for ${opts.repo} returned no html_url (issue #${created.number} exists)`,
      res.status,
      "",
    );
  }
  return { number: created.number, url };
};

/** The number identifying one issue, on every write below. */
type IssueTarget = IssueCallBase & { readonly issue: number };

const issueUrl = (opts: IssueTarget, suffix = ""): string => {
  const { apiBase } = resolveClient(opts);
  const { owner, name } = splitRepo(opts.repo);
  return `${apiBase}/repos/${owner}/${name}/issues/${opts.issue}${suffix}`;
};

export type AddIssueLabelsOptions = IssueTarget & { readonly labels: readonly string[] };

/** Add labels, leaving any already present untouched (GitHub unions them). */
export const addIssueLabels = async (opts: AddIssueLabelsOptions): Promise<void> => {
  if (opts.labels.length === 0) return;
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, "/labels"), {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ labels: opts.labels }),
  });
  await assertOk(res, `label add failed for ${opts.repo}#${opts.issue}`);
};

export type RemoveIssueLabelOptions = IssueTarget & { readonly label: string };

/**
 * Remove one label. A label that is not on the issue answers 404, which is the
 * requested end state rather than a failure — the state machine moves a label
 * off whether or not it was on, and treating "already absent" as an error would
 * make every transition order-dependent.
 */
export const removeIssueLabel = async (opts: RemoveIssueLabelOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, `/labels/${encodeURIComponent(opts.label)}`), {
    method: "DELETE",
    headers: ghHeaders(opts.token),
  });
  if (res.status === 404) return;
  await assertOk(res, `label remove failed for ${opts.repo}#${opts.issue}`);
};

export type CreateIssueCommentOptions = IssueTarget & { readonly body: string };

/** Post one comment. The body is the caller's; this module renders nothing. */
export const createIssueComment = async (opts: CreateIssueCommentOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts, "/comments"), {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ body: opts.body }),
  });
  await assertOk(res, `comment failed for ${opts.repo}#${opts.issue}`);
};

export type CloseIssueAsDuplicateOptions = IssueTarget & {
  /**
   * The issue number this one duplicates. **Required** — see the header: this
   * is what makes closing-on-another-verdict unrepresentable rather than
   * merely disallowed.
   */
  readonly duplicateOf: number;
};

/**
 * Close an issue as a duplicate of `duplicateOf`.
 *
 * The only close in this package, and the only one the triage desk has. GitHub
 * records `state_reason: "duplicate"`, so the *reason* survives in the timeline
 * where a reader (and a later audit) will find it, not only in whatever comment
 * the caller left.
 *
 * --- `duplicateOf` is required, and is NOT sent to GitHub ---------------------
 *
 * Requiring it in the signature is what makes "close on a non-duplicate verdict"
 * unrepresentable at the call site — that is its whole job, and it does it
 * whether or not it reaches the wire. What GitHub currently records is the
 * reason without the target; the *link* to the original reaches the issue as the
 * `#N` cross-reference in the comment the caller posts immediately before this.
 *
 * GitHub does have a parameter for the canonical target — `duplicate_issue_id`,
 * "the ID of the issue to mark as the canonical duplicate when state_reason is
 * duplicate". **It takes the issue's `id`, not its `number`.** `duplicateOf` is
 * a NUMBER (that is what the issue list carries, what the classifier names, and
 * what `knownNumbers` validates against), and the two are unrelated: ids are
 * global and in the hundreds of millions, so passing a number here would mark
 * some arbitrary unrelated issue — very likely in a different repository — as
 * the canonical original.
 *
 * So wiring it up is not a one-line change: `IssueListItem`/`IssueRef` must
 * carry `id` alongside `number`, the normalizer must read it, and the fake must
 * agree. Deliberately left for a follow-up rather than half-done here, because
 * the half-done version is silently wrong in production and green in every test.
 */
export const closeIssueAsDuplicate = async (opts: CloseIssueAsDuplicateOptions): Promise<void> => {
  const { doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts), {
    method: "PATCH",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ state: "closed", state_reason: "duplicate" }),
  });
  await assertOk(
    res,
    `close-as-duplicate failed for ${opts.repo}#${opts.issue} (duplicate of #${opts.duplicateOf})`,
  );
};

// --- closeBotIssue -------------------------------------------------------------
//
// The second close, and the narrow one: a bot-opened issue carrying the caller's
// ledger label closes as `completed` once the condition it reports clears. It
// never touches an issue a person opened, so the verdict it records is the
// loop's claim about its own artifact, never about someone else's report. A
// close on any other verdict, or of any other issue, stays unspellable.

export type CloseBotIssueOptions = IssueTarget & {
  /** The ledger label the issue must carry; an issue without it stays open. */
  readonly label: string;
  /** Posted before the close — a rendered template, never model prose. */
  readonly comment: string;
};

export type CloseBotIssueResult =
  | { readonly closed: true; readonly number: number }
  | {
      readonly closed: false;
      /** `not-open`: already closed. `human-owned` / `foreign-owned`: another author. `unlabelled`: not this ledger. */
      readonly reason: "not-open" | "human-owned" | "foreign-owned" | "unlabelled";
      readonly number: number;
    };

/**
 * Close `issue` as completed — only when it is open, this installation's bot
 * opened it, and it carries `label`. The comment lands first, so the timeline
 * records why before GitHub records `state_reason: "completed"`.
 */
export const closeBotIssue = async (opts: CloseBotIssueOptions): Promise<CloseBotIssueResult> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const res = await doFetch(issueUrl(opts), { headers: ghHeaders(opts.token) });
  await assertOk(res, `issue read failed for ${opts.repo}#${opts.issue}`);
  const issue = (await res.json()) as {
    state?: string;
    user?: { type?: string; login?: string } | null;
    labels?: ReadonlyArray<string | { name?: string }>;
  };
  const number = opts.issue;
  if (issue.state !== "open") return { closed: false, reason: "not-open", number };
  if (issue.user?.type !== "Bot") return { closed: false, reason: "human-owned", number };
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
  if (!labels.includes(opts.label)) return { closed: false, reason: "unlabelled", number };

  const viewerRes = await doFetch(`${apiBase}/graphql`, {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ query: "query { viewer { login } }" }),
  });
  await assertOk(viewerRes, "GitHub App bot identity lookup failed");
  const viewer = (await viewerRes.json()) as {
    data?: { viewer?: { login?: unknown } };
    errors?: unknown;
  };
  const login = viewer.data?.viewer?.login;
  if (viewer.errors !== undefined || typeof login !== "string" || login.length === 0) {
    throw new GithubApiError("GitHub App bot identity unavailable", viewerRes.status, "");
  }
  if (issue.user.login?.toLowerCase() !== login.toLowerCase()) {
    return { closed: false, reason: "foreign-owned", number };
  }

  await createIssueComment({ ...opts, body: opts.comment });
  const close = await doFetch(issueUrl(opts), {
    method: "PATCH",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  await assertOk(close, `close-as-completed failed for ${opts.repo}#${opts.issue}`);
  return { closed: true, number };
};
